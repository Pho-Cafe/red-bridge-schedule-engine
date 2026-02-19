# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Run with tsx (development, no compile step)
npm run watch    # Run with tsx in watch mode (auto-restart on changes)
npm run build    # Compile TypeScript to dist/
npm start        # Run compiled output from dist/
```

No test or lint scripts are configured.

## Architecture

This is a **database-driven cron scheduler** for the Red Bridge platform. It pulls schedule definitions from Firestore and executes them on their configured intervals.

**Flow:**
1. `src/index.ts` — loads `.env` and starts `CronScheduler`
2. `src/services/cron-scheduler.ts` — reads `schedules` collection from Firestore, creates a `CronJob` per schedule, routes each job's `action` field to the appropriate handler
3. Action handlers live in `src/services/` (currently only `teamviewer-heartbeat.ts`)
4. `src/types/schedule.ts` — defines `Schedule` and `ScheduleTask` interfaces

**Adding a new action:** Create a service in `src/services/`, import it in `cron-scheduler.ts`, and add a case to the switch statement.

## Configuration

Required before running:
- `.env` with:
  - `FIREBASE_PROJECT_ID` — Firebase project ID
  - `FIREBASE_CLIENT_EMAIL` — Firebase service account client email
  - `FIREBASE_PRIVATE_KEY` — Firebase service account private key (newlines as `\n`)
  - `TEAMVIEWER_API_TOKEN` — TeamViewer API token
  - `TEAMS_WEBHOOK_URL` — Power Automate webhook URL for Teams notifications
  - `TIMEZONE` — Timezone for cron jobs (defaults to `UTC`)

## Firestore Collections

- `schedules` — each document has `name`, `cronExpression`, `action`, and optional `lastRun`
- `config/teamviewer` — config document with `observeList` array for filtering TeamViewer devices
