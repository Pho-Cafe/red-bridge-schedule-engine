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

  const devices = (
    observeSet
      ? allDevices.filter((device) => observeSet.has(device.id))
      : allDevices
  ).map((device) => ({
    deviceId: device.id,
    name: device.name,
    online: device.isOnline,
  }));

  console.log(
    `teamviewer_heartbeat: checked ${devices.length} devices, ${devices.filter((device) => device.online).length} online`,
  );
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
