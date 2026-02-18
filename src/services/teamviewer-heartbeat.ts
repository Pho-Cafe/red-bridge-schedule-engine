import * as dotenv from 'dotenv';

dotenv.config();

const TEAMVIEWER_API_URL = 'https://webapi.teamviewer.com/api/v1/managed/devices';

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
    throw new Error('TEAMVIEWER_API_TOKEN environment variable not set');
  }

  const observeListRaw = process.env.TEAMVIEWER_OBSERVE_LIST;
  if (!observeListRaw) {
    console.warn('teamviewer_heartbeat: TEAMVIEWER_OBSERVE_LIST not set, checking all devices');
  }

  const observeSet = observeListRaw
    ? new Set(observeListRaw.split(',').map((id) => id.trim()))
    : null;

  const allDevices = await fetchAllManagedDevices(apiToken);

  const devices = (observeSet
    ? allDevices.filter((device) => observeSet.has(device.id))
    : allDevices
  ).map((device) => ({
    deviceId: device.id,
    name: device.name,
    online: device.isOnline,
  }));

  console.log(`teamviewer_heartbeat: checked ${devices.length} devices`);
  for (const device of devices) {
    console.log(`  ${device.name}: ${device.online ? 'online' : 'offline'}`);
  }
}

async function fetchAllManagedDevices(apiToken: string): Promise<ManagedDevice[]> {
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
      throw new Error(`TeamViewer API responded with ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as ManagedDevicesResponse;
    allDevices.push(...data.resources);
    paginationToken = data.nextPaginationToken || undefined;
  } while (paginationToken);

  return allDevices;
}
