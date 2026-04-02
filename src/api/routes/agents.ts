import { Hono } from 'hono';
import type { DatabaseService } from '../../core/database.js';

export function agentRoutes(deps: { db: DatabaseService }) {
  const app = new Hono();

  // List agents
  app.get('/agents', (c) => {
    const agents = deps.db.getAgents();
    return c.json(agents);
  });

  // Get single agent
  app.get('/agents/:id', (c) => {
    const agent = deps.db.getAgent(c.req.param('id'));
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    return c.json(agent);
  });

  // Create agent
  app.post('/agents', async (c) => {
    const body = await c.req.json();
    const agent = deps.db.createAgent(body);
    return c.json(agent, 201);
  });

  // Update agent
  app.put('/agents/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const agent = deps.db.updateAgent(id, body);
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    return c.json(agent);
  });

  // Delete agent
  app.delete('/agents/:id', (c) => {
    const id = c.req.param('id');
    const deleted = deps.db.deleteAgent(id);
    if (!deleted) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}
