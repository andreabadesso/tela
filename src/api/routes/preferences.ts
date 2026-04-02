import { Hono } from 'hono';
import type { DatabaseService } from '../../core/database.js';
import type { AuthUser } from '../middleware.js';

function getUser(c: unknown): AuthUser | undefined {
  return (c as { get(key: string): unknown }).get('user') as AuthUser | undefined;
}

export function preferenceRoutes(deps: { db: DatabaseService }) {
  const app = new Hono();

  // Get my preferences for an agent
  app.get('/my/preferences/:agentId', (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const agentId = c.req.param('agentId');
    const behaviorConfig = deps.db.getBehaviorConfig(agentId, user.id);
    if (!behaviorConfig) {
      return c.json({ config: {} });
    }
    return c.json({ config: JSON.parse(behaviorConfig.config) });
  });

  // Set my preferences for an agent
  app.put('/my/preferences/:agentId', async (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const agentId = c.req.param('agentId');
    const body = await c.req.json();
    const result = deps.db.setBehaviorConfig(agentId, user.id, body.config ?? body);
    return c.json({ config: JSON.parse(result.config) });
  });

  // See what the agent remembers about me
  app.get('/my/memories/:agentId', (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const agentId = c.req.param('agentId');
    const memories = deps.db.getMemories(agentId, { userId: user.id, scope: 'user' });
    return c.json(memories);
  });

  // Ask agent to forget something about me
  app.delete('/my/memories/:agentId/:memoryId', (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const memoryId = c.req.param('memoryId');

    // Verify the memory belongs to this user
    const memory = deps.db.getMemory(memoryId);
    if (!memory) return c.json({ error: 'Memory not found' }, 404);
    if (memory.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);

    deps.db.deleteMemory(memoryId);
    return c.json({ ok: true });
  });

  return app;
}
