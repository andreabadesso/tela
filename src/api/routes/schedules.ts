import { Hono } from 'hono';
import type { DatabaseService } from '../../services/database.js';
import type { JobRegistry } from '../../jobs/registry.js';
import type { CtoAgent } from '../../agent.js';

export function scheduleRoutes(deps: {
  db: DatabaseService;
  jobRegistry: JobRegistry;
  agent: CtoAgent;
}) {
  const app = new Hono();

  // List all schedules
  app.get('/schedules', (c) => {
    const schedules = deps.db.getSchedules();
    return c.json(schedules);
  });

  // Get single schedule
  app.get('/schedules/:id', (c) => {
    const schedule = deps.db.getSchedule(c.req.param('id'));
    if (!schedule) {
      return c.json({ error: 'Schedule not found' }, 404);
    }
    return c.json(schedule);
  });

  // Create schedule
  app.post('/schedules', async (c) => {
    const body = await c.req.json();
    const schedule = deps.db.createSchedule(body);
    return c.json(schedule, 201);
  });

  // Update schedule
  app.put('/schedules/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const schedule = deps.db.updateSchedule(id, body);
    if (!schedule) {
      return c.json({ error: 'Schedule not found' }, 404);
    }
    return c.json(schedule);
  });

  // Delete schedule
  app.delete('/schedules/:id', (c) => {
    const id = c.req.param('id');
    const deleted = deps.db.deleteSchedule(id);
    if (!deleted) {
      return c.json({ error: 'Schedule not found' }, 404);
    }
    return c.json({ ok: true });
  });

  // Run schedule now
  app.post('/schedules/:id/run', async (c) => {
    const id = c.req.param('id');
    const schedule = deps.db.getSchedule(id);
    if (!schedule) {
      return c.json({ error: 'Schedule not found' }, 404);
    }

    try {
      const response = await deps.agent.process({
        text: schedule.prompt,
        source: 'cron',
      });
      deps.db.updateSchedule(id, {
        last_run_at: new Date().toISOString(),
        last_result: response.text.slice(0, 5000),
      });
      return c.json({ ok: true, result: response.text });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
    }
  });

  // Get schedule run history
  app.get('/schedules/:id/history', (c) => {
    const id = c.req.param('id');
    const schedule = deps.db.getSchedule(id);
    if (!schedule) {
      return c.json({ error: 'Schedule not found' }, 404);
    }
    // Get job runs for this schedule from job_runs table
    const runs = deps.db.getScheduleHistory(id, 10);
    return c.json(runs);
  });

  // Get schedule templates
  app.get('/schedule-templates', (c) => {
    return c.json(SCHEDULE_TEMPLATES);
  });

  return app;
}

const SCHEDULE_TEMPLATES = [
  {
    name: 'Morning Briefing',
    cron_expression: '0 8 * * *',
    prompt: 'Generate morning briefing with priorities, attention items, meetings, and carry-over from yesterday.',
  },
  {
    name: 'Midday Check',
    cron_expression: '0 12 * * *',
    prompt: 'Quick midday status: anything urgent or blocked?',
  },
  {
    name: 'Daily Digest',
    cron_expression: '0 20 * * *',
    prompt: 'End of day digest: what happened, what\'s pending.',
  },
  {
    name: 'End of Day',
    cron_expression: '0 21 * * *',
    prompt: 'Prompt for end of day reflection and review.',
  },
  {
    name: 'Week Ahead',
    cron_expression: '0 20 * * 0',
    prompt: 'Plan next week based on calendar, roadmap, and pending items.',
  },
  {
    name: 'Week Review',
    cron_expression: '0 17 * * 5',
    prompt: 'Weekly review: what shipped, metrics, highlights, concerns.',
  },
  {
    name: 'Meeting Prep',
    cron_expression: '*/15 * * * *',
    prompt: 'Check for meetings in next 30 minutes and prep notes.',
  },
  {
    name: 'PR Stale Alerts',
    cron_expression: '0 10 * * *',
    prompt: 'Check for PRs open more than 48h without review.',
  },
  {
    name: 'Blocked Tickets',
    cron_expression: '0 10 * * *',
    prompt: 'Check for Jira tickets blocked more than 24h.',
  },
  {
    name: 'ShipLens Anomaly',
    cron_expression: '0 */4 * * *',
    prompt: 'Check ShipLens for metric anomalies.',
  },
  {
    name: 'Decision Review',
    cron_expression: '0 9 * * 1',
    prompt: 'Review decisions from last 30 days: outcomes match expectations?',
  },
  {
    name: 'Vault Health',
    cron_expression: '0 9 * * 6',
    prompt: 'Run vault health check: orphans, broken links, stale items.',
  },
];
