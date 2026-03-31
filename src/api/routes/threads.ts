import { Hono } from 'hono';
import type { DatabaseService } from '../../services/database.js';
import type { AuthUser } from '../middleware.js';

export function threadRoutes(deps: { db: DatabaseService }) {
  const app = new Hono();

  // List threads for current user (optionally filter by agent)
  app.get('/threads', (c) => {
    const user = c.get('user') as AuthUser | undefined;
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const agentId = c.req.query('agent_id');
    const threads = deps.db.getChatThreads(user.id, agentId || undefined);
    return c.json(threads);
  });

  // Get a single thread with messages
  app.get('/threads/:id', (c) => {
    const user = c.get('user') as AuthUser | undefined;
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const thread = deps.db.getChatThread(c.req.param('id'));
    if (!thread || thread.user_id !== user.id) return c.json({ error: 'Not found' }, 404);
    const messages = deps.db.getChatMessages(thread.id);
    return c.json({ ...thread, messages });
  });

  // Create a new thread
  app.post('/threads', async (c) => {
    const user = c.get('user') as AuthUser | undefined;
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ agent_id: string; title?: string }>();
    if (!body.agent_id) return c.json({ error: 'agent_id required' }, 400);
    const thread = deps.db.createChatThread(user.id, body.agent_id, body.title);
    return c.json(thread, 201);
  });

  // Add message to thread
  app.post('/threads/:id/messages', async (c) => {
    const user = c.get('user') as AuthUser | undefined;
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const thread = deps.db.getChatThread(c.req.param('id'));
    if (!thread || thread.user_id !== user.id) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json<{ role: string; content: string; tool_calls?: unknown[] }>();
    const msgId = deps.db.addChatMessage(thread.id, body.role, body.content, body.tool_calls);
    return c.json({ id: msgId }, 201);
  });

  // Update thread (rename)
  app.put('/threads/:id', async (c) => {
    const user = c.get('user') as AuthUser | undefined;
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const thread = deps.db.getChatThread(c.req.param('id'));
    if (!thread || thread.user_id !== user.id) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json<{ title?: string }>();
    deps.db.updateChatThread(thread.id, body);
    return c.json({ ok: true });
  });

  // Delete thread
  app.delete('/threads/:id', (c) => {
    const user = c.get('user') as AuthUser | undefined;
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const thread = deps.db.getChatThread(c.req.param('id'));
    if (!thread || thread.user_id !== user.id) return c.json({ error: 'Not found' }, 404);
    deps.db.deleteChatThread(thread.id);
    return c.json({ ok: true });
  });

  return app;
}
