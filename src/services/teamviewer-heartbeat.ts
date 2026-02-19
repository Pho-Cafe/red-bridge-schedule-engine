import * as dotenv from "dotenv";
import { db } from "../config/firebase";

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

  await sendTeamsNotification(onlineDevices, offlineDevices);
}

async function sendTeamsNotification(
  onlineDevices: DeviceStatus[],
  offlineDevices: DeviceStatus[],
): Promise<void> {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn(
      "teamviewer_heartbeat: TEAMS_WEBHOOK_URL not set, skipping notification",
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

  if (offlineDevices.length > 0) {
    body.push(
      { type: "TextBlock", weight: "Bolder", text: "⭕ Offline" },
      {
        type: "FactSet",
        facts: offlineDevices.map((d) => ({
          title: d.name,
          value: "Offline",
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
