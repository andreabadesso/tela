import { Hono } from 'hono';
import type { DatabaseService } from '../../core/database.js';

export function memoryRoutes(deps: { db: DatabaseService }) {
  const app = new Hono();

  // List memories for an agent
  app.get('/agents/:agentId/memories', (c) => {
    const agentId = c.req.param('agentId');
    const scope = c.req.query('scope');
    const type = c.req.query('type');
    const userId = c.req.query('userId');
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
    const q = c.req.query('q');

    if (q) {
      const results = deps.db.searchMemories(agentId, q, { userId, scope: scope ?? undefined, limit });
      return c.json(results);
    }

    const memories = deps.db.getMemories(agentId, { userId, scope: scope ?? undefined, type: type ?? undefined, limit });
    return c.json(memories);
  });

  // Create memory manually
  app.post('/agents/:agentId/memories', async (c) => {
    const agentId = c.req.param('agentId');
    const body = await c.req.json();
    const memory = deps.db.createMemory({
      agent_id: agentId,
      user_id: body.user_id ?? null,
      scope: body.scope ?? 'global',
      type: body.type,
      name: body.name,
      description: body.description,
      content: body.content,
      source: 'manual',
      stale_after_days: body.stale_after_days ?? null,
    });
    return c.json(memory, 201);
  });

  // Update memory
  app.put('/agents/:agentId/memories/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const memory = deps.db.updateMemory(id, body);
    if (!memory) {
      return c.json({ error: 'Memory not found' }, 404);
    }
    return c.json(memory);
  });

  // Delete memory
  app.delete('/agents/:agentId/memories/:id', (c) => {
    const id = c.req.param('id');
    const deleted = deps.db.deleteMemory(id);
    if (!deleted) {
      return c.json({ error: 'Memory not found' }, 404);
    }
    return c.json({ ok: true });
  });

  // Get default behavior config
  app.get('/agents/:agentId/behavior', (c) => {
    const agentId = c.req.param('agentId');
    const behaviorConfig = deps.db.getBehaviorConfig(agentId);
    if (!behaviorConfig) {
      return c.json({ config: {} });
    }
    return c.json({ config: JSON.parse(behaviorConfig.config) });
  });

  // Set default behavior config
  app.put('/agents/:agentId/behavior', async (c) => {
    const agentId = c.req.param('agentId');
    const body = await c.req.json();
    const result = deps.db.setBehaviorConfig(agentId, null, body.config ?? body);
    return c.json({ config: JSON.parse(result.config) });
  });

  // Get user-specific behavior override
  app.get('/agents/:agentId/behavior/:userId', (c) => {
    const agentId = c.req.param('agentId');
    const userId = c.req.param('userId');
    const behaviorConfig = deps.db.getBehaviorConfig(agentId, userId);
    if (!behaviorConfig) {
      return c.json({ config: {} });
    }
    return c.json({ config: JSON.parse(behaviorConfig.config) });
  });

  // Set user-specific behavior override
  app.put('/agents/:agentId/behavior/:userId', async (c) => {
    const agentId = c.req.param('agentId');
    const userId = c.req.param('userId');
    const body = await c.req.json();
    const result = deps.db.setBehaviorConfig(agentId, userId, body.config ?? body);
    return c.json({ config: JSON.parse(result.config) });
  });

  return app;
}
