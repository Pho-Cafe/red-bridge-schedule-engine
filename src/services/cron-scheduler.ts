import cron from 'node-cron';
import { Schedule, ScheduleTask } from '../types/schedule';
import { db } from '../config/firebase';
import { ScheduleExecutor } from './schedule-executor';

export class CronScheduler {
  private tasks: Map<string, ScheduleTask> = new Map();
  private executor: ScheduleExecutor;

  constructor() {
    this.executor = new ScheduleExecutor();
  }

  async initialize(): Promise<void> {
    console.log('Initializing cron scheduler...');
    
    try {
      const snapshot = await db.collection('schedules')
        .where('enabled', '==', true)
        .get();

      if (snapshot.empty) {
        console.log('No enabled schedules found');
      } else {
        snapshot.forEach((doc) => {
          const schedule = { id: doc.id, ...doc.data() } as Schedule;
          this.addSchedule(schedule);
        });
        console.log(`Loaded ${this.tasks.size} active schedules`);
      }

      this.watchScheduleChanges();
      
    } catch (error: any) {
      console.error('Error initializing scheduler:', error);
      
      if (error.code === 5) {
        console.log('Schedules collection may not exist yet. Listening for changes...');
        this.watchScheduleChanges();
      } else {
        throw error;
      }
    }
  }

private watchScheduleChanges(): void {
  console.log('Setting up real-time listener...');
  
  db.collection('schedules').onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const schedule = { id: change.doc.id, ...change.doc.data() } as Schedule;
        const existingTask = this.tasks.get(schedule.id);
        
        if (change.type === 'added') {
          // New schedule added
          if (schedule.enabled && !existingTask) {
            console.log(`New schedule added: ${schedule.name}`);
            this.addSchedule(schedule);
          }
          
        } else if (change.type === 'modified') {
          // Schedule was modified - handle all scenarios explicitly
          
          if (schedule.enabled && !existingTask) {
            // Schedule was enabled but wasn't running
            console.log(`Schedule enabled: ${schedule.name}`);
            this.addSchedule(schedule);
            
          } else if (schedule.enabled && existingTask) {
            // Schedule is running and still enabled - check if cron changed
            if (existingTask.cronExpression !== schedule.cronExpression) {
              console.log(`Cron expression changed: ${schedule.name}`);
              this.updateSchedule(schedule);
            } else {
              // Just a timestamp update, ignore it
              console.log(`Ignoring timestamp update: ${schedule.name}`);
            }
            
          } else if (!schedule.enabled && existingTask) {
            // Schedule was disabled and is currently running - stop it
            console.log(`Schedule disabled: ${schedule.name}`);
            this.removeSchedule(schedule.id);
            
          } else if (!schedule.enabled && !existingTask) {
            // Schedule is disabled and not running - nothing to do
            console.log(`Ignoring update to disabled schedule: ${schedule.name}`);
          }
          
        } else if (change.type === 'removed') {
          // Schedule was deleted
          if (existingTask) {
            console.log(`Schedule deleted: ${schedule.name}`);
            this.removeSchedule(schedule.id);
          }
        }
      });
    },
    (error) => {
      console.error('Error in schedule listener:', error);
    }
  );
}

  private addSchedule(schedule: Schedule): void {
    if (!cron.validate(schedule.cronExpression)) {
      console.error(`Invalid cron expression for ${schedule.name}: ${schedule.cronExpression}`);
      return;
    }

    const task = cron.schedule(
      schedule.cronExpression, 
      () => {
        this.executor.execute(schedule);
      }, 
      {
        timezone: process.env.TIMEZONE || 'UTC',
        name: schedule.name,
      }
    );

    this.tasks.set(schedule.id, {
      scheduleId: schedule.id,
      cronExpression: schedule.cronExpression,
      task,
    });

    console.log(`✓ Added schedule: ${schedule.name} (${schedule.cronExpression})`);
  }

  private updateSchedule(schedule: Schedule): void {
    this.removeSchedule(schedule.id);
    this.addSchedule(schedule);
  }

  private removeSchedule(scheduleId: string): void {
    const existingTask = this.tasks.get(scheduleId);
    if (existingTask) {
      existingTask.task.stop();
      this.tasks.delete(scheduleId);
      console.log(`✓ Removed schedule: ${scheduleId}`);
    }
  }

  getActiveSchedules(): string[] {
    return Array.from(this.tasks.keys());
  }

  stop(): void {
    this.tasks.forEach((task) => {
      task.task.stop();
    });
    this.tasks.clear();
    console.log('All schedules stopped');
  }
}