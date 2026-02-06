import { CronScheduler } from './services/cron-scheduler';

const scheduler = new CronScheduler();

async function main() {
  try {
    await scheduler.initialize();
    console.log('Cron scheduler is running...');
    
    // Log active schedules every hour
    setInterval(() => {
      const activeSchedules = scheduler.getActiveSchedules();
      console.log(`Active schedules: ${activeSchedules.length}`);
    }, 60 * 60 * 1000);
    
  } catch (error) {
    console.error('Failed to start scheduler:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  scheduler.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  scheduler.stop();
  process.exit(0);
});

main();