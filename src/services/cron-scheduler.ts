import { CronJob } from 'cron';
import { db } from '../config/firebase';
import { Schedule, ScheduleTask } from '../types/schedule';
import { executeTeamviewerHeartbeat } from './teamviewer-heartbeat';

export class CronScheduler {
  private tasks: Map<string, ScheduleTask> = new Map();

  async initialize(): Promise<void> {
    console.log('Initializing cron scheduler...');

    const schedules = await this.loadSchedules();

    for (const schedule of schedules) {
      this.addSchedule(schedule);
    }

    console.log(`Loaded ${this.tasks.size} schedules`);
  }

  private async loadSchedules(): Promise<Schedule[]> {
    const snapshot = await db.collection('schedules').get();
    return snapshot.docs.map((doc) => doc.data() as Schedule);
  }

  private executeAction(schedule: Schedule): void {
    switch (schedule.action) {
      case 'teamviewer_heartbeat':
        executeTeamviewerHeartbeat().catch((err) =>
          console.error(`Error in ${schedule.name}:`, err)
        );
        break;
      default:
        console.warn(`Unknown action "${schedule.action}" for schedule "${schedule.name}"`);
    }
  }

  private addSchedule(schedule: Schedule): void {
    try {
      const job = new CronJob(
        schedule.cronExpression,
        () => this.executeAction(schedule),
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
