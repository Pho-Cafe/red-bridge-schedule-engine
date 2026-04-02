import * as dotenv from "dotenv";
import admin from "firebase-admin";
import { db } from "../config/firebase";
import { Incident, IncidentEvent, PrtgConfig, PrtgSensor } from "../types/schedule";
import { sendAdaptiveCard } from "./teams-notification";

dotenv.config();

interface PrtgSensorsResponse {
  sensors: PrtgSensor[];
}

export async function executePrtgHeartbeat(): Promise<void> {
  const prtgUrl = process.env.PRTG_URL;
  const prtgApiKey = process.env.PRTG_API_KEY;
  if (!prtgUrl) throw new Error("PRTG_URL environment variable not set");
  if (!prtgApiKey) throw new Error("PRTG_API_KEY environment variable not set");

  const configDoc = await db.doc("config/prtg").get();
  const config: PrtgConfig = configDoc.exists
    ? (configDoc.data() as PrtgConfig)
    : { assignments: {} };

  const sensorToLocation = new Map<string, string>();
  for (const [locationId, objids] of Object.entries(config.assignments)) {
    for (const objid of objids) {
      sensorToLocation.set(objid, locationId);
    }
  }

  const observeSet = new Set(sensorToLocation.keys());

  if (observeSet.size === 0) {
    console.warn("prtg_heartbeat: no assignments found in config/prtg");
    return;
  }

  const allSensors = await fetchPrtgSensors(prtgUrl, prtgApiKey);
  const sensors = allSensors.filter((s) => observeSet.has(String(s.objid)));

  const upSensors = sensors.filter((s) => s.status_raw === 3);
  const downSensors = sensors.filter((s) => s.status_raw !== 3);

  console.log(
    `prtg_heartbeat: checked ${sensors.length} sensors, ${upSensors.length} up`,
  );

  const locationIds = Object.keys(config.assignments);
  const locationNames = await fetchLocationNames(locationIds);

  const openIncidents = await fetchOpenPrtgIncidents();
  const events = processIncidentEvents(sensors, openIncidents, observeSet, sensorToLocation, locationNames);
  await writeIncidentEvents(events);

  console.log(
    `prtg_heartbeat: incidents — ${events.filter((e) => e.type === "new").length} new, ` +
      `${events.filter((e) => e.type === "resolved").length} resolved, ` +
      `${events.filter((e) => e.type === "ongoing").length} ongoing, ` +
      `${events.filter((e) => e.type === "interrupted").length} interrupted`,
  );

  await sendTeamsNotification(upSensors, downSensors, events, locationNames);
}

async function fetchPrtgSensors(url: string, apiKey: string): Promise<PrtgSensor[]> {
  const endpoint = `${url}/table.json?content=sensors&columns=objid,device,name,status,status_raw&apitoken=${apiKey}`;
  const response = await fetch(endpoint);

  if (!response.ok) {
    throw new Error(`PRTG API responded with ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as PrtgSensorsResponse;
  return data.sensors;
}

async function fetchLocationNames(locationIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (locationIds.length === 0) return map;

  const refs = locationIds.map((id) => db.collection("locations").doc(id));
  const docs = await db.getAll(...refs);
  for (const doc of docs) {
    if (doc.exists) {
      map.set(doc.id, doc.data()?.reference ?? doc.id);
    }
  }
  return map;
}

async function fetchOpenPrtgIncidents(): Promise<
  Map<string, { docId: string; incident: Incident }>
> {
  const snapshot = await db
    .collection("incidents")
    .where("status", "==", "open")
    .where("source", "==", "prtg")
    .get();

  const map = new Map<string, { docId: string; incident: Incident }>();
  for (const doc of snapshot.docs) {
    const incident = doc.data() as Incident;
    map.set(incident.deviceId, { docId: doc.id, incident });
  }
  return map;
}

function processIncidentEvents(
  sensors: PrtgSensor[],
  openIncidents: Map<string, { docId: string; incident: Incident }>,
  observeSet: Set<string>,
  sensorToLocation: Map<string, string>,
  locationNames: Map<string, string>,
): IncidentEvent[] {
  const events: IncidentEvent[] = [];
  const processedIds = new Set<string>();

  for (const sensor of sensors) {
    const deviceId = String(sensor.objid);
    processedIds.add(deviceId);
    const existing = openIncidents.get(deviceId);
    const isDown = sensor.status_raw !== 3;

    if (isDown && !existing) {
      const now = admin.firestore.Timestamp.now();
      const locationId = sensorToLocation.get(deviceId)!;
      events.push({
        type: "new",
        docId: "",
        incident: {
          deviceId,
          deviceName: locationNames.get(locationId) ?? locationId,
          locationId,
          status: "open",
          createdAt: now,
          updatedAt: now,
          updateCount: 1,
          source: "prtg",
        },
      });
    } else if (!isDown && existing) {
      const now = admin.firestore.Timestamp.now();
      events.push({
        type: "resolved",
        docId: existing.docId,
        incident: {
          ...existing.incident,
          status: "resolved",
          updatedAt: now,
          resolvedAt: now,
        },
      });
    } else if (isDown && existing) {
      events.push({
        type: "ongoing",
        docId: existing.docId,
        incident: {
          ...existing.incident,
          updatedAt: admin.firestore.Timestamp.now(),
          updateCount: existing.incident.updateCount + 1,
        },
      });
    }
  }

  for (const [deviceId, { docId, incident }] of openIncidents) {
    if (!processedIds.has(deviceId)) {
      const now = admin.firestore.Timestamp.now();
      events.push({
        type: "interrupted",
        docId,
        incident: {
          ...incident,
          status: "interrupted",
          updatedAt: now,
          resolvedAt: now,
        },
      });
    }
  }

  return events;
}

async function writeIncidentEvents(events: IncidentEvent[]): Promise<void> {
  if (events.length === 0) return;

  const batch = db.batch();

  for (const event of events) {
    if (event.type === "new") {
      const ref = db.collection("incidents").doc();
      event.docId = ref.id;
      batch.set(ref, event.incident);
    } else {
      const ref = db.collection("incidents").doc(event.docId);
      batch.update(ref, { ...event.incident });
    }
  }

  await batch.commit();
}

async function sendTeamsNotification(
  upSensors: PrtgSensor[],
  downSensors: PrtgSensor[],
  events: IncidentEvent[],
  locationNames: Map<string, string>,
): Promise<void> {
  const displayName = (e: IncidentEvent) =>
    locationNames.get(e.incident.locationId) ?? e.incident.deviceName;
  const newEvents = events.filter((e) => e.type === "new");
  const resolvedEvents = events.filter((e) => e.type === "resolved");
  const ongoingEvents = events.filter((e) => e.type === "ongoing");
  const interruptedEvents = events.filter((e) => e.type === "interrupted");

  const hasIncidentActivity =
    newEvents.length > 0 ||
    resolvedEvents.length > 0 ||
    interruptedEvents.length > 0;

  if (downSensors.length === 0 && !hasIncidentActivity) {
    console.log(
      "prtg_heartbeat: all sensors up, no incident activity — skipping notification",
    );
    return;
  }

  const total = upSensors.length + downSensors.length;
  const body: object[] = [
    {
      type: "TextBlock",
      size: "Medium",
      weight: "Bolder",
      text: "PRTG Connectivity Status",
    },
    {
      type: "TextBlock",
      text: `${upSensors.length} of ${total} sensors up`,
      wrap: true,
    },
  ];

  if (newEvents.length > 0) {
    body.push(
      {
        type: "TextBlock",
        weight: "Bolder",
        text: "🔴 New Incidents",
        spacing: "Medium",
      },
      {
        type: "FactSet",
        facts: newEvents.map((e) => ({
          title: displayName(e),
          value: "Just went down",
        })),
      },
    );
  }

  if (ongoingEvents.length > 0) {
    body.push(
      {
        type: "TextBlock",
        weight: "Bolder",
        text: "⭕ Ongoing Incidents",
        spacing: "Medium",
      },
      {
        type: "FactSet",
        facts: ongoingEvents.map((e) => ({
          title: displayName(e),
          value: `Down for ${e.incident.updateCount} checks`,
        })),
      },
    );
  }

  if (resolvedEvents.length > 0) {
    body.push(
      {
        type: "TextBlock",
        weight: "Bolder",
        text: "✅ Resolved Incidents",
        spacing: "Medium",
      },
      {
        type: "FactSet",
        facts: resolvedEvents.map((e) => ({
          title: displayName(e),
          value: "Back up",
        })),
      },
    );
  }

  if (interruptedEvents.length > 0) {
    body.push(
      {
        type: "TextBlock",
        weight: "Bolder",
        text: "⚠️ Interrupted Incidents",
        spacing: "Medium",
      },
      {
        type: "FactSet",
        facts: interruptedEvents.map((e) => ({
          title: displayName(e),
          value: "Removed from observe list",
        })),
      },
    );
  }

  await sendAdaptiveCard(body);
  console.log("prtg_heartbeat: Teams notification sent");
}
