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
