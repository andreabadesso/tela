import { Hono } from 'hono';
import type { DatabaseService } from '../../services/database.js';
import type { GitSync } from '../../services/git.js';
import type { JobRegistry } from '../../jobs/registry.js';

const startTime = Date.now();

export function healthRoutes(deps: {
  db: DatabaseService;
  gitSync: GitSync;
  jobRegistry: JobRegistry;
}) {
  const app = new Hono();

  app.get('/health', (c) => {
    const { db, gitSync, jobRegistry } = deps;
    return c.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      lastGitSync: gitSync.lastSyncTime?.toISOString() ?? null,
      lastJobRuns: db.getLastJobRuns(),
      conversationsToday: db.getConversationCountToday(),
      errors24h: db.getErrorCount24h(),
      jobs: jobRegistry.list().map((j) => ({ name: j.name, enabled: j.enabled })),
    });
  });

  return app;
}
