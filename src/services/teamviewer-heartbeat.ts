import * as dotenv from "dotenv";
import admin from "firebase-admin";
import { db } from "../config/firebase";
import { Incident, IncidentEvent } from "../types/schedule";

dotenv.config();

const TEAMVIEWER_API_URL =
  "https://webapi.teamviewer.com/api/v1/managed/devices";

interface ManagedDevice {
  id: string;
  teamviewerId: number;
  name: string;
  isOnline: boolean;
  last_seen: string;
}

interface ManagedDevicesResponse {
  currentPaginationToken: string;
  nextPaginationToken: string;
  resources: ManagedDevice[];
}

interface DeviceStatus {
  deviceId: string;
  name: string;
  online: boolean;
}

export async function executeTeamviewerHeartbeat(): Promise<void> {
  const apiToken = process.env.TEAMVIEWER_API_TOKEN;
  if (!apiToken) {
    throw new Error("TEAMVIEWER_API_TOKEN environment variable not set");
  }

  const configDoc = await db.doc("config/teamviewer").get();
  const observeList: string[] | undefined = configDoc.exists
    ? configDoc.data()?.observeList
    : undefined;

  if (!observeList || observeList.length === 0) {
    console.warn(
      "teamviewer_heartbeat: observeList not set in /config/teamviewer, checking all devices",
    );
  }

  const observeSet =
    observeList && observeList.length > 0 ? new Set(observeList) : null;

  const allDevices = await fetchAllManagedDevices(apiToken);

  const devices: DeviceStatus[] = (
    observeSet
      ? allDevices.filter((device) => observeSet.has(device.id))
      : allDevices
  ).map((device) => ({
    deviceId: device.id,
    name: device.name,
    online: device.isOnline,
  }));

  const onlineDevices = devices.filter((d) => d.online);
  const offlineDevices = devices.filter((d) => !d.online);

  console.log(
    `teamviewer_heartbeat: checked ${devices.length} devices, ${onlineDevices.length} online`,
  );

  // Fetch open incidents and process incident events
  const openIncidents = await fetchOpenIncidents();
  const events = processIncidentEvents(devices, openIncidents, observeSet);
  await writeIncidentEvents(events);

  console.log(
    `teamviewer_heartbeat: incidents — ${events.filter((e) => e.type === "new").length} new, ` +
      `${events.filter((e) => e.type === "resolved").length} resolved, ` +
      `${events.filter((e) => e.type === "ongoing").length} ongoing, ` +
      `${events.filter((e) => e.type === "interrupted").length} interrupted`,
  );

  await sendTeamsNotification(onlineDevices, offlineDevices, events);
}

async function fetchOpenIncidents(): Promise<
  Map<string, { docId: string; incident: Incident }>
> {
  const snapshot = await db
    .collection("incidents")
    .where("status", "==", "open")
    .get();

  const map = new Map<string, { docId: string; incident: Incident }>();
  for (const doc of snapshot.docs) {
    const incident = doc.data() as Incident;
    map.set(incident.deviceId, { docId: doc.id, incident });
  }
  return map;
}

function processIncidentEvents(
  devices: DeviceStatus[],
  openIncidents: Map<string, { docId: string; incident: Incident }>,
  observeSet: Set<string> | null,
): IncidentEvent[] {
  const events: IncidentEvent[] = [];
  const processedDeviceIds = new Set<string>();

  for (const device of devices) {
    processedDeviceIds.add(device.deviceId);
    const existing = openIncidents.get(device.deviceId);

    if (!device.online && !existing) {
      // NEW_INCIDENT: device is offline with no open incident
      const now = admin.firestore.Timestamp.now();
      events.push({
        type: "new",
        docId: "", // will be assigned during write
        incident: {
          deviceId: device.deviceId,
          deviceName: device.name,
          status: "open",
          createdAt: now,
          updatedAt: now,
          updateCount: 1,
        },
      });
    } else if (device.online && existing) {
      // RESOLVED_INCIDENT: device is online but has an open incident
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
    } else if (!device.online && existing) {
      // ONGOING_INCIDENT: device still offline
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
    // device online with no incident = normal, nothing to do
  }

  // INTERRUPTED_INCIDENT: open incident for device no longer in observe list
  for (const [deviceId, { docId, incident }] of openIncidents) {
    if (!processedDeviceIds.has(deviceId)) {
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
  onlineDevices: DeviceStatus[],
  offlineDevices: DeviceStatus[],
  events: IncidentEvent[],
): Promise<void> {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn(
      "teamviewer_heartbeat: TEAMS_WEBHOOK_URL not set, skipping notification",
    );
    return;
  }

  const newEvents = events.filter((e) => e.type === "new");
  const resolvedEvents = events.filter((e) => e.type === "resolved");
  const ongoingEvents = events.filter((e) => e.type === "ongoing");
  const interruptedEvents = events.filter((e) => e.type === "interrupted");

  // Skip notification if all devices online and no incident activity
  const hasIncidentActivity =
    newEvents.length > 0 ||
    resolvedEvents.length > 0 ||
    interruptedEvents.length > 0;

  if (offlineDevices.length === 0 && !hasIncidentActivity) {
    console.log(
      "teamviewer_heartbeat: all devices online, no incident activity — skipping notification",
    );
    return;
  }

  const total = onlineDevices.length + offlineDevices.length;
  const body: object[] = [
    {
      type: "TextBlock",
      size: "Medium",
      weight: "Bolder",
      text: "TeamViewer Device Status",
    },
    {
      type: "TextBlock",
      text: `${onlineDevices.length} of ${total} devices online`,
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
          title: e.incident.deviceName,
          value: "Just went offline",
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
          title: e.incident.deviceName,
          value: `Offline for ${e.incident.updateCount} checks`,
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
          title: e.incident.deviceName,
          value: "Back online",
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
          title: e.incident.deviceName,
          value: "Removed from observe list",
        })),
      },
    );
  }

  const payload = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body,
        },
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `Teams webhook responded with ${response.status}: ${response.statusText}`,
    );
  }

  console.log("teamviewer_heartbeat: Teams notification sent");
}

async function fetchAllManagedDevices(
  apiToken: string,
): Promise<ManagedDevice[]> {
  const allDevices: ManagedDevice[] = [];
  let paginationToken: string | undefined;

  do {
    const url = paginationToken
      ? `${TEAMVIEWER_API_URL}?paginationToken=${encodeURIComponent(paginationToken)}`
      : TEAMVIEWER_API_URL;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!response.ok) {
      throw new Error(
        `TeamViewer API responded with ${response.status}: ${response.statusText}`,
      );
    }

    const data = (await response.json()) as ManagedDevicesResponse;
    allDevices.push(...data.resources);
    paginationToken = data.nextPaginationToken || undefined;
  } while (paginationToken);

  return allDevices;
}
