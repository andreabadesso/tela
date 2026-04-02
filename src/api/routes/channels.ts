import { Hono } from 'hono';
import type { DatabaseService } from '../../core/database.js';
import type { ChannelGateway } from '../../channels/gateway.js';

interface ChannelDeps {
  db: DatabaseService;
  channelGateway: ChannelGateway;
}

export function channelRoutes(deps: ChannelDeps) {
  const app = new Hono();

  // ─── CRUD ──────────────────────────────────────────────────────

  app.get('/channels', (c) => {
    const channels = deps.db.getCommunicationChannels();
    const parsed = channels.map((ch) => ({
      ...ch,
      config: safeParseJson(ch.config),
      is_running: !!deps.channelGateway.getAdapter(ch.id),
    }));
    return c.json(parsed);
  });

  // Summary endpoint for dashboard
  app.get('/channels/summary', (c) => {
    const channels = deps.db.getCommunicationChannels();
    const summary = {
      total: channels.length,
      enabled: channels.filter((ch) => ch.enabled).length,
      running: channels.filter((ch) => !!deps.channelGateway.getAdapter(ch.id)).length,
      by_platform: {} as Record<string, number>,
      by_direction: {} as Record<string, number>,
      errors: channels.filter((ch) => ch.status === 'error').map((ch) => ({
        id: ch.id,
        name: ch.name,
        platform: ch.platform,
        error: ch.error_message,
      })),
    };
    for (const ch of channels) {
      summary.by_platform[ch.platform] = (summary.by_platform[ch.platform] || 0) + 1;
      summary.by_direction[ch.direction] = (summary.by_direction[ch.direction] || 0) + 1;
    }
    return c.json(summary);
  });

  app.get('/channels/:id', (c) => {
    const channel = deps.db.getCommunicationChannel(c.req.param('id'));
    if (!channel) return c.json({ error: 'Channel not found' }, 404);
    return c.json({ ...channel, config: safeParseJson(channel.config) });
  });

  app.post('/channels', async (c) => {
    const body = await c.req.json();

    if (!body.name || !body.platform) {
      return c.json({ error: 'name and platform are required' }, 400);
    }

    const channel = deps.db.createCommunicationChannel({
      id: body.id,
      name: body.name,
      platform: body.platform,
      direction: body.direction ?? 'bidirectional',
      agent_id: body.agent_id ?? null,
      config: typeof body.config === 'string' ? body.config : JSON.stringify(body.config ?? {}),
      enabled: body.enabled ?? 1,
    });

    return c.json({ ...channel, config: safeParseJson(channel.config) }, 201);
  });

  app.put('/channels/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();

    if (body.config && typeof body.config !== 'string') {
      body.config = JSON.stringify(body.config);
    }

    const updated = deps.db.updateCommunicationChannel(id, body);
    if (!updated) return c.json({ error: 'Channel not found' }, 404);

    return c.json({ ...updated, config: safeParseJson(updated.config) });
  });

  app.delete('/channels/:id', async (c) => {
    const id = c.req.param('id');

    // Stop the channel if running
    try {
      await deps.channelGateway.stopChannel(id);
    } catch { /* might not be running */ }

    const deleted = deps.db.deleteCommunicationChannel(id);
    if (!deleted) return c.json({ error: 'Channel not found' }, 404);

    return c.json({ ok: true });
  });

  // ─── Lifecycle ─────────────────────────────────────────────────

  app.post('/channels/:id/start', async (c) => {
    const id = c.req.param('id');
    try {
      await deps.channelGateway.startChannel(id);
      return c.json({ ok: true, status: 'running' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.post('/channels/:id/stop', async (c) => {
    const id = c.req.param('id');
    try {
      await deps.channelGateway.stopChannel(id);
      return c.json({ ok: true, status: 'stopped' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.post('/channels/:id/test', async (c) => {
    const id = c.req.param('id');
    const success = await deps.channelGateway.testChannel(id);
    return c.json({ success });
  });

  // ─── Threads ───────────────────────────────────────────────────

  app.get('/channels/:id/threads', (c) => {
    const id = c.req.param('id');
    const limit = parseInt(c.req.query('limit') ?? '50', 10);
    const threads = deps.db.getChannelThreadsByChannel(id, limit);
    return c.json(threads);
  });

  // ─── Webhooks (for GitHub, Jira, etc.) ─────────────────────────

  app.post('/channels/:id/webhook', async (c) => {
    const id = c.req.param('id');
    const adapter = deps.channelGateway.getAdapter(id);
    if (!adapter) {
      return c.json({ error: 'Channel not running' }, 404);
    }

    const payload = await c.req.json();

    // GitHub webhook
    if ('handleWebhook' in adapter && adapter.platform === 'github') {
      const event = c.req.header('X-GitHub-Event') ?? 'unknown';
      await (adapter as any).handleWebhook(event, payload);
      return c.json({ ok: true });
    }

    // Jira webhook
    if ('handleWebhook' in adapter && adapter.platform === 'jira') {
      const event = payload.webhookEvent ?? 'unknown';
      await (adapter as any).handleWebhook(event, payload);
      return c.json({ ok: true });
    }

    return c.json({ error: 'Webhooks not supported for this platform' }, 400);
  });

  return app;
}

const SENSITIVE_KEYS = ['bot_token', 'api_token', 'private_key', 'signing_secret', 'app_token', 'webhook_secret', 'smtp_pass', 'password'];

function safeParseJson(json: string, redact = true): unknown {
  try {
    const parsed = JSON.parse(json);
    if (redact && typeof parsed === 'object' && parsed !== null) {
      const redacted: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(parsed)) {
        if (SENSITIVE_KEYS.includes(key) && typeof val === 'string' && val.length > 4) {
          redacted[key] = val.slice(0, 4) + '****';
        } else {
          redacted[key] = val;
        }
      }
      return redacted;
    }
    return parsed;
  } catch {
    return {};
  }
}
