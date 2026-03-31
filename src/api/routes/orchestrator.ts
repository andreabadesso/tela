import { Hono } from 'hono';
import type { Orchestrator } from '../../orchestrator/index.js';
import type { DatabaseService } from '../../services/database.js';

export function orchestratorRoutes(deps: { orchestrator: Orchestrator; db: DatabaseService }) {
  const app = new Hono();

  // Assign task to agent (background execution)
  app.post('/tasks/assign', async (c) => {
    const body = await c.req.json<{ taskRef: string; agentId: string; prompt: string }>();
    if (!body.taskRef || !body.agentId || !body.prompt) {
      return c.json({ error: 'Missing required fields: taskRef, agentId, prompt' }, 400);
    }

    try {
      const runId = await deps.orchestrator.assign(body.taskRef, body.agentId, body.prompt);
      return c.json({ runId, status: 'assigned' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: message }, 400);
    }
  });

  // Council mode — multiple agents process same query
  app.post('/tasks/council', async (c) => {
    const body = await c.req.json<{ text: string; agentIds: string[] }>();
    if (!body.text || !body.agentIds?.length) {
      return c.json({ error: 'Missing required fields: text, agentIds' }, 400);
    }

    try {
      const results = await deps.orchestrator.council(
        { text: body.text, source: 'web' },
        body.agentIds,
      );
      return c.json({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: message }, 500);
    }
  });

  // List approvals
  app.get('/approvals', async (c) => {
    const status = c.req.query('status');
    const agentId = c.req.query('agentId');
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);

    const approvals = deps.db.getApprovals({ status, agentId, limit, offset });
    return c.json({ approvals });
  });

  // Resolve an approval
  app.post('/approvals/:id', async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json<{ status: 'approved' | 'rejected'; resolvedBy?: string }>();

    if (!body.status || !['approved', 'rejected'].includes(body.status)) {
      return c.json({ error: 'status must be "approved" or "rejected"' }, 400);
    }

    const approval = deps.db.getApproval(id);
    if (!approval) {
      return c.json({ error: 'Approval not found' }, 404);
    }
    if (approval.status !== 'pending') {
      return c.json({ error: `Approval already resolved: ${approval.status}` }, 400);
    }

    const resolved = deps.db.resolveApproval(id, body.resolvedBy ?? 'api', body.status);
    return c.json({ approval: resolved });
  });

  return app;
}
