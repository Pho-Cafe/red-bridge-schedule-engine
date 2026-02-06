import admin from 'firebase-admin';

export interface Schedule {
  id: string;
  name: string;
  cronExpression: string;
  enabled: boolean;
  action: string;
  actionData?: Record<string, any>;
  lastRun?: admin.firestore.Timestamp;
  nextRun?: admin.firestore.Timestamp;
  createdAt: admin.firestore.Timestamp;
  updatedAt: admin.firestore.Timestamp;
}

export interface ScheduleTask {
  scheduleId: string;
  cronExpression: string;
  task: any; // node-cron ScheduledTask
}