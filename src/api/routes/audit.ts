import { Hono } from 'hono';
import type { DatabaseService } from '../../core/database.js';

export function auditRoutes(deps: { db: DatabaseService }) {
  const app = new Hono();

  // List audit log entries (paginated, filterable)
  app.get('/audit', (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);
    const agentId = c.req.query('agent_id') || undefined;
    const action = c.req.query('action') || undefined;
    const source = c.req.query('source') || undefined;
    const from = c.req.query('from') || undefined;
    const to = c.req.query('to') || undefined;

    const entries = deps.db.getAuditLog({ limit, offset, agentId, action, source, from, to });
    const total = deps.db.getAuditLogCount({ agentId, action, source, from, to });

    return c.json({ entries, total, limit, offset });
  });

  return app;
}
