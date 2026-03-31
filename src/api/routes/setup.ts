import { Hono } from 'hono';
import type { DatabaseService } from '../../services/database.js';
import type { AuthUser } from '../middleware.js';

type Env = { Variables: { user: AuthUser } };

export function setupRoutes(deps: { db: DatabaseService }) {
  const app = new Hono<Env>();

  // Check if first-run setup is needed
  app.get('/setup/status', (c) => {
    const setupCompleted = deps.db.getSetting('setup_completed');
    return c.json({ setupCompleted: setupCompleted === 'true' });
  });

  // Mark setup as complete
  app.post('/setup/complete', async (c) => {
    const user = c.get('user');

    // Accept company info if provided
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.companyName) {
      deps.db.setSetting('company_name', body.companyName as string);
    }
    if (body.timezone) {
      deps.db.setSetting('company_timezone', body.timezone as string);
    }
    if (body.defaultModel) {
      deps.db.setSetting('default_model', body.defaultModel as string);
    }

    deps.db.setSetting('setup_completed', 'true');
    console.log(`[setup] Setup completed by ${user?.email || 'unknown'}`);
    return c.json({ ok: true });
  });

  // Get onboarding status for current user
  app.get('/onboarding', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const onboarded = deps.db.isUserOnboarded(user.id);

    const connections = deps.db.getConnections();
    const tools = connections
      .filter((conn) => conn.status === 'connected')
      .map((conn) => ({ name: conn.name, type: conn.type }));

    return c.json({
      onboarded,
      role: user.roles[0] || 'viewer',
      roles: user.roles,
      teams: user.teams,
      tools,
    });
  });

  // Mark user onboarding as complete
  app.post('/onboarding/complete', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    deps.db.markUserOnboarded(user.id);

    return c.json({ ok: true });
  });

  return app;
}
