import { Hono } from 'hono';
import type { DatabaseService } from '../../services/database.js';

export function settingsRoutes(deps: { db: DatabaseService }) {
  const app = new Hono();

  // Get all settings
  app.get('/settings', (c) => {
    const settings = deps.db.getAllSettings();
    return c.json(settings);
  });

  // Get single setting
  app.get('/settings/:key', (c) => {
    const key = c.req.param('key');
    const value = deps.db.getSetting(key);
    if (value === undefined) {
      return c.json({ error: 'Setting not found' }, 404);
    }
    return c.json({ key, value });
  });

  // Set setting value
  app.put('/settings/:key', async (c) => {
    const key = c.req.param('key');
    const body = await c.req.json();
    deps.db.setSetting(key, body.value);
    return c.json({ key, value: body.value });
  });

  // Delete setting
  app.delete('/settings/:key', (c) => {
    const key = c.req.param('key');
    const deleted = deps.db.deleteSetting(key);
    if (!deleted) {
      return c.json({ error: 'Setting not found' }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}
