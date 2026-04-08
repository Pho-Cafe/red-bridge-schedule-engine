import { CronJob } from 'cron';
import { db } from '../config/firebase';
import { Schedule, ScheduleTask } from '../types/schedule';
import { executeTeamviewerHeartbeat } from './teamviewer-heartbeat';
import { executeIncidentReport } from './incident-report';
import { executePrtgHeartbeat } from './prtg-heartbeat';

export class CronScheduler {
  private tasks: Map<string, ScheduleTask> = new Map();

  async initialize(): Promise<void> {
    console.log('Initializing cron scheduler...');

    const schedules = await this.loadSchedules();

    for (const { id, schedule } of schedules) {
      this.addSchedule(id, schedule);
    }

    console.log(`Loaded ${this.tasks.size} schedules`);
  }

  private async loadSchedules(): Promise<{ id: string; schedule: Schedule }[]> {
    const snapshot = await db.collection('schedules').get();
    return snapshot.docs.map((doc) => ({ id: doc.id, schedule: doc.data() as Schedule }));
  }

  private async getScheduleState(docId: string): Promise<{ active: boolean; notifications: boolean }> {
    const doc = await db.collection('schedules').doc(docId).get();
    if (!doc.exists) return { active: false, notifications: false };
    const data = doc.data() as Schedule;
    return {
      active: data.active !== false,
      notifications: data.notifications !== false,
    };
  }

  private executeAction(schedule: Schedule, notifications: boolean): void {
    switch (schedule.action) {
      case 'teamviewer_heartbeat':
        executeTeamviewerHeartbeat(notifications).catch((err) =>
          console.error(`Error in ${schedule.name}:`, err)
        );
        break;
      case 'incident_report':
        executeIncidentReport(schedule.name, schedule.config, notifications).catch((err) =>
          console.error(`Error in ${schedule.name}:`, err)
        );
        break;
      case 'prtg_heartbeat':
        executePrtgHeartbeat(notifications).catch((err) =>
          console.error(`Error in ${schedule.name}:`, err)
        );
        break;
      default:
        console.warn(`Unknown action "${schedule.action}" for schedule "${schedule.name}. Double check the schedule name, or restart deployment if action has been recently implemented."`);
    }
  }

  private addSchedule(docId: string, schedule: Schedule): void {
    try {
      const job = new CronJob(
        schedule.cronExpression,
        async () => {
          const state = await this.getScheduleState(docId);
          if (!state.active) {
            console.log(`Skipping "${schedule.name}" — schedule is inactive`);
            return;
          }
          if (!state.notifications) {
            console.log(`"${schedule.name}" — notifications disabled, running without Teams messages`);
          }
          this.executeAction(schedule, state.notifications);
        },
        null,
        true,
        process.env.TIMEZONE || 'UTC'
      );

      this.tasks.set(schedule.name, {
        name: schedule.name,
        cronExpression: schedule.cronExpression,
        task: job,
      });

      console.log(`Added schedule: ${schedule.name} (${schedule.cronExpression})`);
    } catch (err) {
      console.error(`Invalid cron expression for "${schedule.name}": ${schedule.cronExpression}`, err);
    }
  }

  getActiveSchedules(): string[] {
    return Array.from(this.tasks.keys());
  }

  stop(): void {
    this.tasks.forEach((task) => task.task.stop());
    this.tasks.clear();
    console.log('All schedules stopped');
  }
}
