import admin from 'firebase-admin';
import { CronJob } from 'cron';

export interface Schedule {
  name: string;
  cronExpression: string;
  action: string;
  active: boolean;
  lastRun?: admin.firestore.Timestamp;
  config?: Record<string, unknown>;
}

export interface ReportConfig {
  startHour: number;
  endHour: number;
  title?: string;
}

export interface ScheduleTask {
  name: string;
  cronExpression: string;
  task: CronJob;
}

export interface PrtgSensor {
  objid: number;
  device: string;
  name: string;
  status: string;
  status_raw: number;
}

export interface PrtgConfig {
  assignments: Record<string, string[]>;
}

export interface Incident {
  deviceId: string;
  deviceName: string;
  locationId: string;
  status: 'open' | 'resolved' | 'interrupted';
  createdAt: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
  resolvedAt?: admin.firestore.Timestamp;
  updateCount: number;
  source?: 'prtg' | 'teamviewer';
}

export interface LocationIncidentSummary {
  locationId: string;
  locationName: string;
  newThisWindow: Incident[];
  ongoingFromBefore: Incident[];
  resolvedIncidents: Incident[];
  interruptedIncidents: Incident[];
}

export interface IncidentReport {
  title: string;
  generatedAt: admin.firestore.Timestamp;
  timezone: string;
  window: {
    startHour: number;
    endHour: number;
    startAt: admin.firestore.Timestamp;
    endAt: admin.firestore.Timestamp;
  };
  hasIssues: boolean;
  locations: LocationIncidentSummary[];
  repeatOffenders: { name: string; count: number }[];
}

export type IncidentEventType = 'new' | 'resolved' | 'ongoing' | 'interrupted';

export interface IncidentEvent {
  type: IncidentEventType;
  incident: Incident;
  docId: string;
}
