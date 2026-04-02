import { Hono } from 'hono';
import type { DatabaseService } from '../../core/database.js';
import { EncryptionService } from '../../core/encryption.js';
import type { AuthUser } from '../middleware.js';
import { OAUTH_PROVIDERS, getBaseUrl, callbackPage } from './connections-shared.js';

type Env = { Variables: { user: AuthUser } };

// ─── State management for OAuth CSRF ────────────────────────────

const oauthStates = new Map<string, { type: string; expiresAt: number }>();

function generateState(type: string): string {
  const state = crypto.randomUUID();
  oauthStates.set(state, { type, expiresAt: Date.now() + 10 * 60 * 1000 });
  return state;
}

function validateState(state: string): string | null {
  const entry = oauthStates.get(state);
  if (!entry) return null;
  oauthStates.delete(state);
  if (Date.now() > entry.expiresAt) return null;
  return entry.type;
}

// Clean up expired states periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of oauthStates) {
    if (now > val.expiresAt) oauthStates.delete(key);
  }
}, 60_000);

// ─── Routes ─────────────────────────────────────────────────────

export function connectionRoutes(deps: { db: DatabaseService }) {
  const app = new Hono<Env>();
  const encryption = new EncryptionService();

  // List all connections (admin view)
  app.get('/connections', (c) => {
    const connections = deps.db.getConnections().map((conn) => ({
      ...conn,
      credentials: undefined, // Never expose credentials
    }));
    return c.json(connections);
  });

  // List connections available to the current user (based on RBAC)
  app.get('/my-available-connections', (c) => {
    const user = c.get('user') as { id: string; roles: string[] } | undefined;
    if (!user) return c.json([], 200);

    // Admin sees all
    if (user.roles.includes('admin')) {
      const connections = deps.db.getConnections().map((conn) => ({
        ...conn,
        credentials: undefined,
      }));
      return c.json(connections);
    }

    // Regular user: connections filtered by their roles/teams
    const connections = deps.db.getConnectionsForUser(user.id).map((conn) => ({
      ...conn,
      credentials: undefined,
    }));
    return c.json(connections);
  });

  // Create a connection (for API key type)
  app.post('/connections', async (c) => {
    const body = await c.req.json();
    const { name, type, config, apiKey, mcpServerUrl } = body as {
      name: string;
      type: string;
      config?: Record<string, unknown>;
      apiKey?: string;
      mcpServerUrl?: string;
    };

    if (!name || !type) {
      return c.json({ error: 'name and type are required' }, 400);
    }

    const credentials = apiKey ? encryption.encrypt(JSON.stringify({ apiKey })) : null;

    const connection = deps.db.createConnection({
      id: crypto.randomUUID(),
      name,
      type,
      status: apiKey ? 'connected' : 'disconnected',
      config: JSON.stringify(config || {}),
      credentials,
      mcp_server_url: mcpServerUrl || null,
      last_sync_at: null,
      error_message: null,
    });

    return c.json({ ...connection, credentials: undefined }, 201);
  });

  // Initiate OAuth flow
  app.get('/connections/:type/auth', (c) => {
    const type = c.req.param('type');
    const provider = OAUTH_PROVIDERS[type];

    if (!provider) {
      return c.json({ error: `Unknown OAuth provider: ${type}` }, 400);
    }

    const clientId = process.env[provider.clientIdEnv];
    if (!clientId) {
      return c.json({ error: `${provider.clientIdEnv} not configured` }, 400);
    }

    const baseUrl = getBaseUrl(c);
    const redirectUri = `${baseUrl}/api/connections/${type}/callback`;
    const state = generateState(type);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope: provider.scopes.join(' '),
    });

    // Jira-specific: audience and prompt
    if (type === 'jira') {
      params.set('audience', 'api.atlassian.com');
      params.set('prompt', 'consent');
    }

    // Google-specific: access_type for refresh token
    if (type === 'google') {
      params.set('access_type', 'offline');
      params.set('prompt', 'consent');
    }

    const authUrl = `${provider.authUrl}?${params.toString()}`;
    return c.redirect(authUrl);
  });

  // OAuth callback
  app.get('/connections/:type/callback', async (c) => {
    const type = c.req.param('type');
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) {
      return c.html(callbackPage(false, `OAuth error: ${error}`));
    }

    if (!code || !state) {
      return c.html(callbackPage(false, 'Missing code or state parameter'));
    }

    const validatedType = validateState(state);
    if (!validatedType || validatedType !== type) {
      return c.html(callbackPage(false, 'Invalid or expired state parameter'));
    }

    const provider = OAUTH_PROVIDERS[type];
    if (!provider) {
      return c.html(callbackPage(false, `Unknown provider: ${type}`));
    }

    const clientId = process.env[provider.clientIdEnv];
    const clientSecret = process.env[provider.clientSecretEnv];
    if (!clientId || !clientSecret) {
      return c.html(callbackPage(false, 'OAuth credentials not configured on server'));
    }

    const baseUrl = getBaseUrl(c);
    const redirectUri = `${baseUrl}/api/connections/${type}/callback`;

    try {
      // Exchange code for tokens
      const tokenParams: Record<string, string> = {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };

      // GitHub wants Accept: application/json
      if (type === 'github') {
        headers['Accept'] = 'application/json';
      }

      const tokenRes = await fetch(provider.tokenUrl, {
        method: 'POST',
        headers,
        body: new URLSearchParams(tokenParams).toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error(`[connections] Token exchange failed for ${type}:`, errText);
        return c.html(callbackPage(false, 'Token exchange failed'));
      }

      const tokenData = await tokenRes.json() as Record<string, unknown>;

      // Encrypt and store tokens
      const encryptedCredentials = encryption.encrypt(JSON.stringify(tokenData));

      // Find existing connection of this type, or create new one
      const existingConnections = deps.db.getConnections().filter((conn) => conn.type === type);
      if (existingConnections.length > 0) {
        deps.db.updateConnection(existingConnections[0].id, {
          credentials: encryptedCredentials,
          status: 'connected',
          error_message: null,
          updated_at: new Date().toISOString(),
        });
      } else {
        deps.db.createConnection({
          id: crypto.randomUUID(),
          name: provider.name,
          type,
          status: 'connected',
          config: '{}',
          credentials: encryptedCredentials,
          mcp_server_url: null,
          last_sync_at: null,
          error_message: null,
        });
      }

      return c.html(callbackPage(true, `${provider.name} connected successfully!`));
    } catch (err) {
      console.error(`[connections] OAuth callback error for ${type}:`, err);
      return c.html(callbackPage(false, 'An error occurred during authentication'));
    }
  });

  // Test connection
  app.post('/connections/:type/test', async (c) => {
    const type = c.req.param('type');
    const connections = deps.db.getConnections().filter((conn) => conn.type === type);

    if (connections.length === 0) {
      return c.json({ ok: false, error: 'Connection not found' }, 404);
    }

    const connection = connections[0];
    if (!connection.credentials) {
      return c.json({ ok: false, error: 'No credentials stored' }, 400);
    }

    try {
      const creds = JSON.parse(encryption.decrypt(connection.credentials)) as Record<string, unknown>;

      // Provider-specific test logic
      let testOk = false;
      let detail = '';

      if (type === 'github') {
        const token = (creds.access_token as string) || (creds.apiKey as string);
        const res = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Tela/0.1' },
        });
        testOk = res.ok;
        if (res.ok) {
          const user = await res.json() as { login: string };
          detail = `Authenticated as ${user.login}`;
        } else {
          detail = `GitHub API returned ${res.status}`;
        }
      } else if (type === 'google') {
        const token = creds.access_token as string;
        const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
          headers: { Authorization: `Bearer ${token}` },
        });
        testOk = res.ok;
        detail = res.ok ? 'Google credentials valid' : `Google API returned ${res.status}`;
      } else if (type === 'jira') {
        const token = creds.access_token as string;
        const res = await fetch('https://api.atlassian.com/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        testOk = res.ok;
        detail = res.ok ? 'Jira credentials valid' : `Jira API returned ${res.status}`;
      } else if (type === 'shiplens' || type === 'api_key') {
        // For API key connections, just verify the key exists
        testOk = !!creds.apiKey;
        detail = testOk ? 'API key is configured' : 'No API key found';
      } else {
        testOk = !!connection.credentials;
        detail = testOk ? 'Credentials stored' : 'No credentials';
      }

      // Update connection status based on test
      deps.db.updateConnection(connection.id, {
        status: testOk ? 'connected' : 'error',
        error_message: testOk ? null : detail,
        updated_at: new Date().toISOString(),
      });

      return c.json({ ok: testOk, detail });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      deps.db.updateConnection(connection.id, {
        status: 'error',
        error_message: message,
        updated_at: new Date().toISOString(),
      });
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // Delete connection
  app.delete('/connections/:id', (c) => {
    const id = c.req.param('id');
    const deleted = deps.db.deleteConnection(id);
    if (!deleted) {
      return c.json({ error: 'Connection not found' }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}

