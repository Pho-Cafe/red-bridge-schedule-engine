import admin from 'firebase-admin';
import { Schedule } from '../types/schedule';
import { db } from '../config/firebase';

export class ScheduleExecutor {
  
  async execute(schedule: Schedule): Promise<void> {
    console.log(`[${new Date().toISOString()}] Executing schedule: ${schedule.name} (${schedule.id})`);
    
    try {
      // Execute the scheduled action based on the action type
      await this.performAction(schedule);
      
      // Update last run timestamp
      await this.updateLastRun(schedule.id);
      
      console.log(`[${new Date().toISOString()}] Successfully completed: ${schedule.name}`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error executing schedule ${schedule.name}:`, error);
      await this.logError(schedule.id, error);
    }
  }

  private async performAction(schedule: Schedule): Promise<void> {
    switch (schedule.action) {
      case 'log':
        console.log('Action data:', schedule.actionData);
        break;
      
      case 'http_request':
        // Example: Make HTTP request
        // await this.makeHttpRequest(schedule.actionData);
        console.log("doing the http_request...");
        break;
      
      case 'database_cleanup':
        // Example: Clean up old data
        // await this.cleanupDatabase(schedule.actionData);
        console.log("doing the database_cleanup...");
        break;
      
      default:
        console.warn(`Unknown action type: ${schedule.action}`);
    }
  }

  private async updateLastRun(scheduleId: string): Promise<void> {
    await db.collection('schedules').doc(scheduleId).update({
      lastRun: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  private async logError(scheduleId: string, error: any): Promise<void> {
    await db.collection('schedule_logs').add({
      scheduleId,
      error: error.message || String(error),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}