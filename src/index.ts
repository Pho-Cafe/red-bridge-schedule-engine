import * as dotenv from 'dotenv';

dotenv.config();

import { CronScheduler } from './services/cron-scheduler';

const scheduler = new CronScheduler();

scheduler.initialize().catch((err) => {
  console.error('Failed to initialize scheduler:', err);
  process.exit(1);
});
