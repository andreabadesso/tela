import { Hono } from 'hono';
import type { DatabaseService } from '../../services/database.js';
import { EncryptionService } from '../../services/encryption.js';
import type { AuthUser } from '../middleware.js';

type Env = { Variables: { user: AuthUser } };

// ─── OAuth Provider Definitions (shared with connections.ts) ───

interface OAuthProvider {
  type: string;
  name: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
}

const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  jira: {
    type: 'jira',
    name: 'Jira',
    authUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    scopes: ['read:jira-work', 'read:jira-user', 'write:jira-work'],
    clientIdEnv: 'JIRA_CLIENT_ID',
    clientSecretEnv: 'JIRA_CLIENT_SECRET',
  },
  github: {
    type: 'github',
    name: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:org'],
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
  },
  google: {
    type: 'google',
    name: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  },
};

// ─── State management for user OAuth CSRF ──────────────────────

const oauthStates = new Map<string, { connectionId: string; userId: string; type: string; expiresAt: number }>();

function generateState(connectionId: string, userId: string, type: string): string {
  const state = crypto.randomUUID();
  oauthStates.set(state, { connectionId, userId, type, expiresAt: Date.now() + 10 * 60 * 1000 });
  return state;
}

function validateState(state: string): { connectionId: string; userId: string; type: string } | null {
  const entry = oauthStates.get(state);
  if (!entry) return null;
  oauthStates.delete(state);
  if (Date.now() > entry.expiresAt) return null;
  return { connectionId: entry.connectionId, userId: entry.userId, type: entry.type };
}

// Clean up expired states periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of oauthStates) {
    if (now > val.expiresAt) oauthStates.delete(key);
  }
}, 60_000);

// ─── Routes ─────────────────────────────────────────────────────

export function userConnectionRoutes(deps: { db: DatabaseService }) {
  const app = new Hono<Env>();
  const encryption = new EncryptionService();

  const getBaseUrl = (c: { req: { header: (name: string) => string | undefined; url: string } }): string => {
    const proto = c.req.header('x-forwarded-proto') || 'http';
    const host = c.req.header('host') || 'localhost:3000';
    return `${proto}://${host}`;
  };

  // List current user's connections with status
  app.get('/me/connections', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    // Get all company connections
    const connections = deps.db.getConnections();
    // Get user's personal connections
    const userConnections = deps.db.getUserConnections(user.id);
    const userConnMap = new Map(userConnections.map((uc) => [uc.connection_id, uc]));

    const result = connections.map((conn) => {
      const userConn = userConnMap.get(conn.id);
      return {
        id: conn.id,
        name: conn.name,
        type: conn.type,
        token_strategy: conn.token_strategy || 'company',
        company_status: conn.status,
        user_status: conn.token_strategy === 'user'
          ? (userConn?.status || 'not_connected')
          : conn.status,
        user_connection_id: userConn?.id || null,
        error_message: userConn?.error_message || conn.error_message,
        mcp_server_url: conn.mcp_server_url,
      };
    });

    return c.json(result);
  });

  // Initiate user-specific OAuth
  app.post('/connections/:connectionId/auth/user', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const connectionId = c.req.param('connectionId');
    const connection = deps.db.getConnection(connectionId);
    if (!connection) return c.json({ error: 'Connection not found' }, 404);

    if (connection.token_strategy !== 'user') {
      return c.json({ error: 'This connection does not support user-delegated auth' }, 400);
    }

    const provider = OAUTH_PROVIDERS[connection.type];
    if (!provider) {
      return c.json({ error: `No OAuth provider for type: ${connection.type}` }, 400);
    }

    const clientId = process.env[provider.clientIdEnv];
    if (!clientId) {
      return c.json({ error: `${provider.clientIdEnv} not configured` }, 400);
    }

    const baseUrl = getBaseUrl(c);
    const redirectUri = `${baseUrl}/api/connections/${connectionId}/callback/user`;
    const state = generateState(connectionId, user.id, connection.type);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope: provider.scopes.join(' '),
    });

    if (connection.type === 'jira') {
      params.set('audience', 'api.atlassian.com');
      params.set('prompt', 'consent');
    }

    if (connection.type === 'google') {
      params.set('access_type', 'offline');
      params.set('prompt', 'consent');
    }

    const authUrl = `${provider.authUrl}?${params.toString()}`;
    return c.json({ authUrl });
  });

  // User OAuth callback
  app.get('/connections/:connectionId/callback/user', async (c) => {
    const connectionId = c.req.param('connectionId');
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) {
      return c.html(callbackPage(false, `OAuth error: ${error}`));
    }

    if (!code || !state) {
      return c.html(callbackPage(false, 'Missing code or state parameter'));
    }

    const validated = validateState(state);
    if (!validated || validated.connectionId !== connectionId) {
      return c.html(callbackPage(false, 'Invalid or expired state parameter'));
    }

    const connection = deps.db.getConnection(connectionId);
    if (!connection) {
      return c.html(callbackPage(false, 'Connection not found'));
    }

    const provider = OAUTH_PROVIDERS[connection.type];
    if (!provider) {
      return c.html(callbackPage(false, `Unknown provider: ${connection.type}`));
    }

    const clientId = process.env[provider.clientIdEnv];
    const clientSecret = process.env[provider.clientSecretEnv];
    if (!clientId || !clientSecret) {
      return c.html(callbackPage(false, 'OAuth credentials not configured on server'));
    }

    const baseUrl = getBaseUrl(c);
    const redirectUri = `${baseUrl}/api/connections/${connectionId}/callback/user`;

    try {
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

      if (connection.type === 'github') {
        headers['Accept'] = 'application/json';
      }

      const tokenRes = await fetch(provider.tokenUrl, {
        method: 'POST',
        headers,
        body: new URLSearchParams(tokenParams).toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error(`[user-connections] Token exchange failed for ${connection.type}:`, errText);
        return c.html(callbackPage(false, 'Token exchange failed'));
      }

      const tokenData = await tokenRes.json() as Record<string, unknown>;
      const encryptedCredentials = encryption.encrypt(JSON.stringify(tokenData));

      // Upsert user connection
      const existing = deps.db.getUserConnection(validated.userId, connectionId);
      if (existing) {
        deps.db.updateUserConnection(existing.id, {
          credentials: encryptedCredentials,
          status: 'connected',
          error_message: null,
          updated_at: new Date().toISOString(),
        });
      } else {
        deps.db.createUserConnection({
          id: crypto.randomUUID(),
          user_id: validated.userId,
          connection_id: connectionId,
          credentials: encryptedCredentials,
          status: 'connected',
          error_message: null,
        });
      }

      return c.html(callbackPage(true, `${provider.name} connected successfully!`));
    } catch (err) {
      console.error(`[user-connections] OAuth callback error:`, err);
      return c.html(callbackPage(false, 'An error occurred during authentication'));
    }
  });

  // Test user's connection
  app.post('/connections/:connectionId/test/user', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const connectionId = c.req.param('connectionId');
    const connection = deps.db.getConnection(connectionId);
    if (!connection) return c.json({ ok: false, error: 'Connection not found' }, 404);

    const userConn = deps.db.getUserConnection(user.id, connectionId);
    if (!userConn || !userConn.credentials) {
      return c.json({ ok: false, error: 'No user credentials stored' }, 400);
    }

    try {
      const creds = JSON.parse(encryption.decrypt(userConn.credentials)) as Record<string, unknown>;
      let testOk = false;
      let detail = '';

      if (connection.type === 'github') {
        const token = (creds.access_token as string) || (creds.apiKey as string);
        const res = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Tela/0.1' },
        });
        testOk = res.ok;
        if (res.ok) {
          const ghUser = await res.json() as { login: string };
          detail = `Authenticated as ${ghUser.login}`;
        } else {
          detail = `GitHub API returned ${res.status}`;
        }
      } else if (connection.type === 'google') {
        const token = creds.access_token as string;
        const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
          headers: { Authorization: `Bearer ${token}` },
        });
        testOk = res.ok;
        detail = res.ok ? 'Google credentials valid' : `Google API returned ${res.status}`;
      } else if (connection.type === 'jira') {
        const token = creds.access_token as string;
        const res = await fetch('https://api.atlassian.com/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        testOk = res.ok;
        detail = res.ok ? 'Jira credentials valid' : `Jira API returned ${res.status}`;
      } else {
        testOk = !!userConn.credentials;
        detail = testOk ? 'Credentials stored' : 'No credentials';
      }

      deps.db.updateUserConnection(userConn.id, {
        status: testOk ? 'connected' : 'error',
        error_message: testOk ? null : detail,
        updated_at: new Date().toISOString(),
      });

      return c.json({ ok: testOk, detail });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      deps.db.updateUserConnection(userConn.id, {
        status: 'error',
        error_message: message,
        updated_at: new Date().toISOString(),
      });
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // Disconnect user's connection
  app.delete('/me/connections/:connectionId', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const connectionId = c.req.param('connectionId');
    const userConn = deps.db.getUserConnection(user.id, connectionId);
    if (!userConn) {
      return c.json({ error: 'User connection not found' }, 404);
    }

    deps.db.deleteUserConnection(userConn.id);
    return c.json({ ok: true });
  });

  return app;
}

// ─── Callback HTML page ─────────────────────────────────────────

function callbackPage(success: boolean, message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Connection ${success ? 'Success' : 'Failed'}</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0b; color: #fafafa; }
    .card { text-align: center; padding: 2rem; border-radius: 8px; border: 1px solid #27272a; background: #18181b; max-width: 400px; }
    .icon { font-size: 48px; margin-bottom: 1rem; }
    .message { color: #a1a1aa; margin-top: 0.5rem; }
    .close-hint { color: #52525b; margin-top: 1rem; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? '&#10003;' : '&#10007;'}</div>
    <h2>${success ? 'Connected!' : 'Connection Failed'}</h2>
    <p class="message">${message}</p>
    <p class="close-hint">This window will close automatically...</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'oauth-callback', success: ${success} }, '*');
    }
    setTimeout(() => window.close(), 2000);
  </script>
</body>
</html>`;
}
