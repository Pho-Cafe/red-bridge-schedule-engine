import admin from "firebase-admin";
import { db } from "../config/firebase";
import { Incident, IncidentReport, ReportConfig } from "../types/schedule";
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
    title: typeof raw.title === "string" ? raw.title : undefined,
  };
}

export async function executeIncidentReport(
  rawConfig: Record<string, unknown> | undefined,
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

  const title = config.title || "Incident Report";
  const timeLabel = formatTimeRange(start, end, timezone);

  console.log(`incident_report: generating "${title}" for ${timeLabel}`);

  // Currently open incidents (still offline)
  const openSnapshot = await db
    .collection("incidents")
    .where("status", "==", "open")
    .get();
  const openIncidents = openSnapshot.docs.map((d) => d.data() as Incident);

  // Resolved during this window
  const resolvedSnapshot = await db
    .collection("incidents")
    .where("status", "==", "resolved")
    .where("resolvedAt", ">=", startTs)
    .where("resolvedAt", "<=", endTs)
    .get();
  const resolvedIncidents = resolvedSnapshot.docs.map(
    (d) => d.data() as Incident,
  );

  // Interrupted during this window
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

  console.log(
    `incident_report: ${newThisWindow.length} new, ${ongoingFromBefore.length} ongoing, ` +
      `${resolvedIncidents.length} resolved, ${interruptedIncidents.length} interrupted, ` +
      `${repeatOffenders.length} repeat offenders`,
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
    newThisWindow,
    ongoingFromBefore,
    resolvedIncidents,
    interruptedIncidents,
    repeatOffenders,
  };

  await writeIncidentReport(report);
  console.log(`incident_report: "${title}" persisted to Firestore`);

  const body = buildReportCard({
    title,
    timeLabel,
    timezone,
    hasAnyIssues,
    newThisWindow,
    ongoingFromBefore,
    resolvedIncidents,
    interruptedIncidents,
    repeatOffenders,
  });

  await sendAdaptiveCard(body);
  console.log(`incident_report: "${title}" notification sent`);
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
  newThisWindow: Incident[];
  ongoingFromBefore: Incident[];
  resolvedIncidents: Incident[];
  interruptedIncidents: Incident[];
  repeatOffenders: { name: string; count: number }[];
}

function buildReportCard(input: ReportCardInput): object[] {
  const {
    title,
    timeLabel,
    timezone,
    hasAnyIssues,
    newThisWindow,
    ongoingFromBefore,
    resolvedIncidents,
    interruptedIncidents,
    repeatOffenders,
  } = input;

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
      text: "✅ **All Clear** — No incidents were recorded during this period.",
      wrap: true,
      spacing: "Medium",
    });
    return body;
  }

  if (newThisWindow.length > 0) {
    body.push(
      {
        type: "TextBlock",
        weight: "Bolder",
        text: `🔴 New Incidents (${newThisWindow.length})`,
        spacing: "Medium",
      },
      {
        type: "FactSet",
        facts: newThisWindow.map((i) => ({
          title: i.deviceName,
          value: `Offline since ${formatTimestamp(i.createdAt, timezone)}`,
        })),
      },
    );
  }

  if (ongoingFromBefore.length > 0) {
    body.push(
      {
        type: "TextBlock",
        weight: "Bolder",
        text: `⭕ Still Offline (${ongoingFromBefore.length})`,
        spacing: "Medium",
      },
      {
        type: "FactSet",
        facts: ongoingFromBefore.map((i) => ({
          title: i.deviceName,
          value: `Offline since ${formatTimestamp(i.createdAt, timezone)}, ${i.updateCount} checks`,
        })),
      },
    );
  }

  if (resolvedIncidents.length > 0) {
    body.push(
      {
        type: "TextBlock",
        weight: "Bolder",
        text: `✅ Came Back Online (${resolvedIncidents.length})`,
        spacing: "Medium",
      },
      {
        type: "FactSet",
        facts: resolvedIncidents.map((i) => ({
          title: i.deviceName,
          value: `Offline ${formatTimestamp(i.createdAt, timezone)} – ${formatTimestamp(i.resolvedAt!, timezone)}`,
        })),
      },
    );
  }

  if (interruptedIncidents.length > 0) {
    body.push(
      {
        type: "TextBlock",
        weight: "Bolder",
        text: `⚠️ Interrupted (${interruptedIncidents.length})`,
        spacing: "Medium",
      },
      {
        type: "FactSet",
        facts: interruptedIncidents.map((i) => ({
          title: i.deviceName,
          value: "Removed from observe list",
        })),
      },
    );
  }

  if (repeatOffenders.length > 0) {
    body.push(
      {
        type: "TextBlock",
        weight: "Bolder",
        text: `🔁 Repeat Issues`,
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
  const parts: string[] = [];
  if (newThisWindow.length > 0) parts.push(`${newThisWindow.length} new`);
  if (ongoingFromBefore.length > 0)
    parts.push(`${ongoingFromBefore.length} ongoing`);
  if (resolvedIncidents.length > 0)
    parts.push(`${resolvedIncidents.length} resolved`);
  if (interruptedIncidents.length > 0)
    parts.push(`${interruptedIncidents.length} interrupted`);

  body.push({
    type: "TextBlock",
    text: `**Summary:** ${parts.join(", ")}`,
    wrap: true,
    spacing: "Medium",
    isSubtle: true,
  });

  return body;
}
