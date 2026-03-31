import { Hono } from 'hono';
import type { DatabaseService } from '../../services/database.js';

export function conversationRoutes(deps: { db: DatabaseService }) {
  const app = new Hono();

  // List conversations (paginated)
  app.get('/conversations', (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);
    const source = c.req.query('source');

    const conversations = deps.db.getConversations({ limit, offset, source });
    const total = deps.db.getConversationCount(source);

    return c.json({ conversations, total, limit, offset });
  });

  // Get single conversation
  app.get('/conversations/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const conversation = deps.db.getConversation(id);
    if (!conversation) {
      return c.json({ error: 'Conversation not found' }, 404);
    }
    return c.json(conversation);
  });

  // Delete conversation
  app.delete('/conversations/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const deleted = deps.db.deleteConversation(id);
    if (!deleted) {
      return c.json({ error: 'Conversation not found' }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}
