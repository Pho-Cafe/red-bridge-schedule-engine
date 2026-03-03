import admin from 'firebase-admin';
import { CronJob } from 'cron';

export interface Schedule {
  name: string;
  cronExpression: string;
  action: string;
  lastRun?: admin.firestore.Timestamp;
}

export interface ScheduleTask {
  name: string;
  cronExpression: string;
  task: CronJob;
}

export interface Incident {
  deviceId: string;
  deviceName: string;
  status: 'open' | 'resolved' | 'interrupted';
  createdAt: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
  resolvedAt?: admin.firestore.Timestamp;
  updateCount: number;
}

export type IncidentEventType = 'new' | 'resolved' | 'ongoing' | 'interrupted';

export interface IncidentEvent {
  type: IncidentEventType;
  incident: Incident;
  docId: string;
}
