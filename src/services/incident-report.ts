import admin from "firebase-admin";
import { db } from "../config/firebase";
import {
  Incident,
  IncidentReport,
  LocationIncidentSummary,
  ReportConfig,
} from "../types/schedule";
import { sendAdaptiveCard } from "./teams-notification";

function parseReportConfig(
  raw: Record<string, unknown> | undefined,
): ReportConfig {
  if (
    !raw ||
    typeof raw.startHour !== "number" ||
    typeof raw.endHour !== "number"
  ) {
    throw new Error(
      "incident_report: config must include startHour and endHour (numbers)",
    );
  }
  return {
    startHour: raw.startHour,
    endHour: raw.endHour,
  };
}

export async function executeIncidentReport(
  name: string,
  rawConfig: Record<string, unknown> | undefined,
  notifications: boolean,
): Promise<void> {
  const config = parseReportConfig(rawConfig);
  const timezone = process.env.TIMEZONE || "UTC";
  const { start, end } = getWindowBoundaries(
    config.startHour,
    config.endHour,
    timezone,
  );
  const startTs = admin.firestore.Timestamp.fromDate(start);
  const endTs = admin.firestore.Timestamp.fromDate(end);

  const title = name;
  const timeLabel = formatTimeRange(start, end, timezone);

  console.log(`incident_report: generating "${title}" for ${timeLabel}`);

  // Currently open devices (still offline)
  const openSnapshot = await db
    .collection("incidents")
    .where("status", "==", "open")
    .get();
  const openIncidents = openSnapshot.docs.map((d) => d.data() as Incident);

  // Devices that came back online during this window
  const resolvedSnapshot = await db
    .collection("incidents")
    .where("status", "==", "resolved")
    .where("resolvedAt", ">=", startTs)
    .where("resolvedAt", "<=", endTs)
    .get();
  const resolvedIncidents = resolvedSnapshot.docs.map(
    (d) => d.data() as Incident,
  );

  // Devices removed from observe list during this window
  const interruptedSnapshot = await db
    .collection("incidents")
    .where("status", "==", "interrupted")
    .where("resolvedAt", ">=", startTs)
    .where("resolvedAt", "<=", endTs)
    .get();
  const interruptedIncidents = interruptedSnapshot.docs.map(
    (d) => d.data() as Incident,
  );

  // Split open incidents into new-this-window vs ongoing-from-before
  const newThisWindow = openIncidents.filter(
    (i) => i.createdAt.toMillis() >= startTs.toMillis(),
  );
  const ongoingFromBefore = openIncidents.filter(
    (i) => i.createdAt.toMillis() < startTs.toMillis(),
  );

  // Detect repeat offenders: devices with multiple incidents created in this window
  const incidentsCreatedInWindow = [
    ...openIncidents,
    ...resolvedIncidents,
    ...interruptedIncidents,
  ].filter((i) => i.createdAt.toMillis() >= startTs.toMillis());

  const deviceCounts = new Map<string, { name: string; count: number }>();
  for (const incident of incidentsCreatedInWindow) {
    const existing = deviceCounts.get(incident.deviceId);
    if (existing) existing.count++;
    else
      deviceCounts.set(incident.deviceId, {
        name: incident.deviceName,
        count: 1,
      });
  }
  const repeatOffenders = [...deviceCounts.entries()]
    .filter(([, v]) => v.count > 1)
    .map(([, v]) => v);

  const hasAnyIssues =
    newThisWindow.length > 0 ||
    ongoingFromBefore.length > 0 ||
    resolvedIncidents.length > 0 ||
    interruptedIncidents.length > 0;

  // Fetch location names for all locationIds referenced by incidents
  const allIncidents = [
    ...newThisWindow,
    ...ongoingFromBefore,
    ...resolvedIncidents,
    ...interruptedIncidents,
  ];
  const locationIds = [...new Set(allIncidents.map((i) => i.locationId))];
  const locationNames = await fetchLocationNames(locationIds);

  // Group incidents by location
  const locationMap = new Map<string, LocationIncidentSummary>();

  function getOrCreateLocation(locationId: string): LocationIncidentSummary {
    if (!locationMap.has(locationId)) {
      locationMap.set(locationId, {
        locationId,
        locationName: locationNames.get(locationId) ?? locationId,
        newThisWindow: [],
        ongoingFromBefore: [],
        resolvedIncidents: [],
        interruptedIncidents: [],
      });
    }
    return locationMap.get(locationId)!;
  }

  for (const i of newThisWindow) getOrCreateLocation(i.locationId).newThisWindow.push(i);
  for (const i of ongoingFromBefore) getOrCreateLocation(i.locationId).ongoingFromBefore.push(i);
  for (const i of resolvedIncidents) getOrCreateLocation(i.locationId).resolvedIncidents.push(i);
  for (const i of interruptedIncidents) getOrCreateLocation(i.locationId).interruptedIncidents.push(i);

  // Sort: locations with active issues first, then alphabetically
  const locations = [...locationMap.values()].sort((a, b) => {
    const aActive = a.newThisWindow.length + a.ongoingFromBefore.length;
    const bActive = b.newThisWindow.length + b.ongoingFromBefore.length;
    if (aActive !== bActive) return bActive - aActive;
    return a.locationName.localeCompare(b.locationName);
  });

  console.log(
    `incident_report: ${newThisWindow.length} new, ${ongoingFromBefore.length} ongoing, ` +
      `${resolvedIncidents.length} resolved, ${interruptedIncidents.length} interrupted, ` +
      `${repeatOffenders.length} repeat offenders across ${locations.length} location(s)`,
  );

  const report: IncidentReport = {
    title,
    generatedAt: admin.firestore.Timestamp.now(),
    timezone,
    window: {
      startHour: config.startHour,
      endHour: config.endHour,
      startAt: startTs,
      endAt: endTs,
    },
    hasIssues: hasAnyIssues,
    locations,
    repeatOffenders,
  };

  await writeIncidentReport(report);
  console.log(`incident_report: "${title}" persisted to Firestore`);

  if (notifications) {
    const body = buildReportCard({
      title,
      timeLabel,
      timezone,
      hasAnyIssues,
      locations,
      repeatOffenders,
    });

    await sendAdaptiveCard(body);
    console.log(`incident_report: "${title}" notification sent`);
  } else {
    console.log(`incident_report: "${title}" notifications disabled — skipping Teams message`);
  }
}

async function fetchLocationNames(
  locationIds: string[],
): Promise<Map<string, string>> {
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

function getWindowBoundaries(
  startHour: number,
  endHour: number,
  timezone: string,
): { start: Date; end: Date } {
  const now = new Date();

  // Get today's date in the target timezone
  const localNow = new Date(
    now.toLocaleString("en-US", { timeZone: timezone }),
  );
  const offsetMs = localNow.getTime() - now.getTime();

  const localStart = new Date(localNow);
  localStart.setHours(startHour, 0, 0, 0);

  const localEnd = new Date(localNow);
  localEnd.setHours(endHour, 0, 0, 0);

  // If endHour <= startHour, the window wraps past midnight
  if (endHour <= startHour) {
    localEnd.setDate(localEnd.getDate() + 1);
  }

  return {
    start: new Date(localStart.getTime() - offsetMs),
    end: new Date(localEnd.getTime() - offsetMs),
  };
}

function formatTimeRange(start: Date, end: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${fmt.format(start)} – ${fmt.format(end)}, ${dateFmt.format(start)}`;
}

function formatTimestamp(ts: admin.firestore.Timestamp, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return fmt.format(ts.toDate());
}

async function writeIncidentReport(report: IncidentReport): Promise<void> {
  await db.collection("incident_reports").add(report);
}

interface ReportCardInput {
  title: string;
  timeLabel: string;
  timezone: string;
  hasAnyIssues: boolean;
  locations: LocationIncidentSummary[];
  repeatOffenders: { name: string; count: number }[];
}

function buildReportCard(input: ReportCardInput): object[] {
  const { title, timeLabel, timezone, hasAnyIssues, locations, repeatOffenders } = input;

  const body: object[] = [
    {
      type: "TextBlock",
      size: "Medium",
      weight: "Bolder",
      text: `📊 ${title}`,
    },
    {
      type: "TextBlock",
      text: timeLabel,
      isSubtle: true,
      spacing: "None",
    },
  ];

  if (!hasAnyIssues) {
    body.push({
      type: "TextBlock",
      text: "✅ **All Clear** — No offline devices were recorded during this period.",
      wrap: true,
      spacing: "Medium",
    });
    return body;
  }

  for (const loc of locations) {
    const facts: { title: string; value: string }[] = [];

    for (const i of loc.newThisWindow) {
      facts.push({
        title: `🔴 ${i.deviceName}`,
        value: `Offline since ${formatTimestamp(i.createdAt, timezone)}`,
      });
    }
    for (const i of loc.ongoingFromBefore) {
      facts.push({
        title: `⭕ ${i.deviceName}`,
        value: `Offline since ${formatTimestamp(i.createdAt, timezone)}, ${i.updateCount} checks`,
      });
    }
    for (const i of loc.resolvedIncidents) {
      facts.push({
        title: `✅ ${i.deviceName}`,
        value: `Offline ${formatTimestamp(i.createdAt, timezone)} – ${formatTimestamp(i.resolvedAt!, timezone)}`,
      });
    }
    for (const i of loc.interruptedIncidents) {
      facts.push({
        title: `⚠️ ${i.deviceName}`,
        value: "Removed from observe list",
      });
    }

    if (facts.length === 0) continue;

    body.push(
      {
        type: "TextBlock",
        weight: "Bolder",
        text: `📍 ${loc.locationName}`,
        spacing: "Medium",
      },
      { type: "FactSet", facts },
    );
  }

  if (repeatOffenders.length > 0) {
    body.push(
      {
        type: "TextBlock",
        weight: "Bolder",
        text: "🔁 Repeat Offenders",
        spacing: "Medium",
      },
      {
        type: "FactSet",
        facts: repeatOffenders.map((r) => ({
          title: r.name,
          value: `${r.count} incidents this period`,
        })),
      },
    );
  }

  // Summary line
  const totalNew = locations.reduce((n, l) => n + l.newThisWindow.length, 0);
  const totalOngoing = locations.reduce((n, l) => n + l.ongoingFromBefore.length, 0);
  const totalResolved = locations.reduce((n, l) => n + l.resolvedIncidents.length, 0);
  const totalInterrupted = locations.reduce((n, l) => n + l.interruptedIncidents.length, 0);

  const parts: string[] = [];
  if (totalNew > 0) parts.push(`${totalNew} new`);
  if (totalOngoing > 0) parts.push(`${totalOngoing} ongoing`);
  if (totalResolved > 0) parts.push(`${totalResolved} resolved`);
  if (totalInterrupted > 0) parts.push(`${totalInterrupted} interrupted`);

  body.push({
    type: "TextBlock",
    text: `**Summary:** ${parts.join(", ")} across ${locations.length} location(s)`,
    wrap: true,
    spacing: "Medium",
    isSubtle: true,
  });

  return body;
}
