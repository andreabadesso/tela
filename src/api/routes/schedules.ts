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

  // List all schedules (optionally filter by status or type)
  app.get('/schedules', (c) => {
    let schedules = deps.db.getSchedules();
    const status = c.req.query('status');
    const type = c.req.query('type');
    if (status) schedules = schedules.filter((s) => s.status === status);
    if (type) schedules = schedules.filter((s) => s.type === type);
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
    prompt: 'Search the vault for today\'s daily note and yesterday\'s note. Check the calendar for today\'s meetings. Generate a morning briefing with: priorities, attention items, meetings, and carry-over from yesterday.',
  },
  {
    name: 'End of Day Reflection',
    cron_expression: '0 18 * * 1-5',
    prompt: 'Ask the user how their day went. Based on their response, update today\'s daily note with a summary. Use vault tools to discover the right paths — search for existing daily notes to match the convention.',
  },
  {
    name: 'Weekly Review',
    cron_expression: '0 17 * * 5',
    prompt: 'Read this week\'s daily notes from the vault. Generate a weekly review: what got done, what\'s pending, decisions made, patterns noticed, and suggestions for next week. Save the review to the vault alongside other weekly reviews.',
  },
  {
    name: 'Week Ahead Planning',
    cron_expression: '0 20 * * 0',
    prompt: 'Check the calendar for next week\'s meetings. Search the vault for pending items and roadmap. Generate a week-ahead plan with focus areas per day.',
  },
  {
    name: 'Meeting Prep',
    cron_expression: '*/15 * * * *',
    prompt: 'Check calendar for meetings starting in the next 30 minutes. For each, search the vault for context about attendees and topics. Send a prep summary only if a meeting is found.',
  },
  {
    name: 'Stale PR Alerts',
    cron_expression: '0 10 * * *',
    prompt: 'Check for PRs open more than 48h without review. Alert only if stale PRs are found.',
  },
  {
    name: 'Decision Review',
    cron_expression: '0 9 * * 1',
    prompt: 'Search the vault for decisions with review dates. For any due or overdue, prompt the user to review whether the decision still holds.',
  },
  {
    name: 'Vault Health Check',
    cron_expression: '0 9 * * 6',
    prompt: 'Scan the vault for orphaned notes (no inbound links), broken wikilinks, empty files, and stale content (not updated in 60+ days). Generate a health report.',
  },
];
