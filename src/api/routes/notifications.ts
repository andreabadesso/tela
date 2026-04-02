import { Hono } from 'hono';
import type { DatabaseService } from '../../core/database.js';
import type { NotificationManager } from '../../notifications/manager.js';
import type { NotificationMessage } from '../../notifications/types.js';

interface NotificationDeps {
  db: DatabaseService;
  notificationManager: NotificationManager;
}

export function notificationRoutes(deps: NotificationDeps) {
  const app = new Hono();

  // ─── Channel CRUD ──────────────────────────────────────────────

  // List all channels
  app.get('/notifications/channels', (c) => {
    const channels = deps.db.getNotificationChannels();
    return c.json(channels);
  });

  // Create channel
  app.post('/notifications/channels', async (c) => {
    const body = await c.req.json();
    const channel = deps.db.createNotificationChannel({
      id: body.id,
      type: body.type,
      name: body.name,
      config: typeof body.config === 'string' ? body.config : JSON.stringify(body.config ?? {}),
      enabled: body.enabled ?? 1,
    });
    await deps.notificationManager.reload();
    return c.json(channel, 201);
  });

  // Update channel
  app.put('/notifications/channels/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    if (body.config && typeof body.config !== 'string') {
      body.config = JSON.stringify(body.config);
    }
    const updated = deps.db.updateNotificationChannel(id, body);
    if (!updated) {
      return c.json({ error: 'Channel not found' }, 404);
    }
    await deps.notificationManager.reload();
    return c.json(updated);
  });

  // Delete channel
  app.delete('/notifications/channels/:id', (c) => {
    const id = c.req.param('id');
    const deleted = deps.db.deleteNotificationChannel(id);
    if (!deleted) {
      return c.json({ error: 'Channel not found' }, 404);
    }
    deps.notificationManager.reload();
    return c.json({ ok: true });
  });

  // Test channel
  app.post('/notifications/channels/:id/test', async (c) => {
    const id = c.req.param('id');
    // Ensure channels are loaded
    await deps.notificationManager.reload();
    const success = await deps.notificationManager.test(id);
    return c.json({ success });
  });

  // ─── Send ──────────────────────────────────────────────────────

  app.post('/notifications/send', async (c) => {
    const body = await c.req.json();
    const channelIds: string[] = body.channelIds;
    const message: NotificationMessage = body.message;

    if (!channelIds?.length || !message?.body) {
      return c.json({ error: 'channelIds and message.body are required' }, 400);
    }

    message.priority = message.priority ?? 'normal';
    message.source = message.source ?? 'api';

    await deps.notificationManager.send(channelIds, message);
    return c.json({ ok: true });
  });

  // ─── Web Notifications (stored) ───────────────────────────────

  app.get('/notifications', (c) => {
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const offset = parseInt(c.req.query('offset') ?? '0', 10);
    const readFilter = c.req.query('read');
    const notifications = deps.db.getNotifications({ limit, offset, read: readFilter === undefined ? undefined : readFilter === '1' });
    return c.json(notifications);
  });

  app.get('/notifications/unread-count', (c) => {
    const count = deps.db.getUnreadNotificationCount();
    return c.json({ count });
  });

  app.post('/notifications/:id/read', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    deps.db.markNotificationAsRead(id);
    return c.json({ ok: true });
  });

  return app;
}
