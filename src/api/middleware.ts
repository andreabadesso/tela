import type { Context, Next } from 'hono';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import path from 'node:path';
// Auth instance type (inline to avoid importing auth/index.ts which pulls in better-auth)
type BetterAuthInstance = { api: { getSession: (opts: { headers: Headers }) => Promise<{ user?: { id: string; email: string; name?: string | null } } | null> } } | null;

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  roles: string[];
  teams: string[];
}

const API_TOKEN = process.env.API_TOKEN;
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'agent.db');

// Shared read-only connection for auth lookups (WAL mode allows concurrent reads)
let _authDb: Database.Database | null = null;
function getAuthDb(): Database.Database {
  if (!_authDb) {
    _authDb = new Database(DB_PATH, { readonly: false });
    _authDb.pragma('journal_mode = WAL');
  }
  return _authDb;
}

/**
 * Build the auth middleware with access to the better-auth instance.
 * Auth resolution order:
 * 1. better-auth session cookie
 * 2. API key (Bearer token -> hash -> lookup in user_api_keys)
 * 3. Legacy API_TOKEN env var (super-admin fallback)
 */
export function createAuthMiddleware(auth: BetterAuthInstance | null) {
  return async function authMiddleware(c: Context, next: Next) {
    // 1. Try better-auth session (cookie-based)
    if (auth) {
      try {
        const session = await auth.api.getSession({
          headers: c.req.raw.headers,
        });
        if (session?.user) {
          const user = resolveUserContext(session.user.id, session.user.email, session.user.name ?? null);
          c.set('user', user);
          return next();
        }
      } catch {
        // Session resolution failed -- fall through to other methods
      }
    }

    // 2. Try API key auth (Bearer token)
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);

      // 2a. Check user_api_keys table
      const keyHash = hashApiKey(token);
      const apiKeyUser = resolveApiKeyUser(keyHash);
      if (apiKeyUser) {
        c.set('user', apiKeyUser);
        return next();
      }

      // 2b. Legacy API_TOKEN fallback (super-admin)
      if (API_TOKEN && token === API_TOKEN) {
        c.set('user', {
          id: 'system',
          email: 'system@tela.local',
          name: 'System',
          roles: ['admin'],
          teams: [],
        } satisfies AuthUser);
        return next();
      }
    }

    // 3. If no API_TOKEN configured and no auth instance, allow open access (dev mode)
    if (!API_TOKEN && !auth) {
      c.set('user', {
        id: 'dev',
        email: 'dev@tela.local',
        name: 'Developer',
        roles: ['admin'],
        teams: [],
      } satisfies AuthUser);
      return next();
    }

    return c.json({ error: 'Unauthorized' }, 401);
  };
}

/**
 * Primary middleware: session cookie → API key → legacy API_TOKEN → 401
 */
export async function authMiddleware(c: Context, next: Next) {
  // 1. Try session cookie
  const sessionToken = c.req.raw.headers.get('cookie')
    ?.split(';')
    .map(s => s.trim())
    .find(s => s.startsWith('session_token='))
    ?.split('=')[1];

  if (sessionToken) {
    try {
      const db = getAuthDb();
      const session = db.prepare(`
        SELECT s.user_id, u.email, u.name
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > datetime('now')
      `).get(sessionToken) as { user_id: string; email: string; name: string } | undefined;

      if (session) {
        c.set('user', resolveUserContext(session.user_id, session.email, session.name));
        return next();
      }
    } catch {
      // Fall through
    }
  }

  // 2. Try Bearer token (API key or legacy)
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    // 2a. Try user API key
    const keyHash = hashApiKey(token);
    const apiKeyUser = resolveApiKeyUser(keyHash);
    if (apiKeyUser) {
      c.set('user', apiKeyUser);
      return next();
    }

    // 2b. Legacy API_TOKEN
    if (API_TOKEN && token === API_TOKEN) {
      c.set('user', {
        id: 'system',
        email: 'system@tela.local',
        name: 'System',
        roles: ['admin'],
        teams: [],
      } satisfies AuthUser);
      return next();
    }
  }

  // 3. Dev mode: no API_TOKEN set → open access
  if (!API_TOKEN) {
    c.set('user', {
      id: 'dev',
      email: 'dev@tela.local',
      name: 'Developer',
      roles: ['admin'],
      teams: [],
    } satisfies AuthUser);
    return next();
  }

  return c.json({ error: 'Unauthorized' }, 401);
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function resolveApiKeyUser(keyHash: string): AuthUser | null {
  try {
    const db = getAuthDb();
    const row = db.prepare(`
      SELECT u.id, u.email, u.name, ak.id as key_id
      FROM user_api_keys ak
      JOIN users u ON u.id = ak.user_id
      WHERE ak.key_hash = ?
        AND (ak.expires_at IS NULL OR ak.expires_at > datetime('now'))
    `).get(keyHash) as { id: string; email: string; name: string | null; key_id: string } | undefined;

    if (!row) return null;

    // Update last_used_at
    db.prepare("UPDATE user_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.key_id);

    return resolveUserContext(row.id, row.email, row.name);
  } catch {
    return null;
  }
}

function resolveUserContext(userId: string, email: string, name: string | null): AuthUser {
  try {
    const db = getAuthDb();

    const roles = (db.prepare(`
      SELECT r.name FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
    `).all(userId) as { name: string }[]).map(r => r.name);

    const teams = (db.prepare(`
      SELECT t.name FROM user_teams ut
      JOIN teams t ON t.id = ut.team_id
      WHERE ut.user_id = ?
    `).all(userId) as { name: string }[]).map(t => t.name);

    return {
      id: userId,
      email,
      name,
      roles: roles.length > 0 ? roles : ['viewer'],
      teams,
    };
  } catch {
    // Tables may not exist yet
    return { id: userId, email, name, roles: ['viewer'], teams: [] };
  }
}

/** Resolve user from a session token (for WebSocket auth). */
export async function resolveUserFromToken(auth: BetterAuthInstance | null, token: string): Promise<AuthUser | null> {
  // Try API key first
  const keyHash = hashApiKey(token);
  const apiKeyUser = resolveApiKeyUser(keyHash);
  if (apiKeyUser) return apiKeyUser;

  // Try legacy API_TOKEN
  if (API_TOKEN && token === API_TOKEN) {
    return {
      id: 'system',
      email: 'system@tela.local',
      name: 'System',
      roles: ['admin'],
      teams: [],
    };
  }

  // Try better-auth session token
  if (auth) {
    try {
      const db = getAuthDb();
      const session = db.prepare(`
        SELECT s.user_id, u.email, u.name
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ?
          AND s.expires_at > datetime('now')
      `).get(token) as { user_id: string; email: string; name: string | null } | undefined;

      if (session) {
        return resolveUserContext(session.user_id, session.email, session.name);
      }
    } catch {
      // Fall through
    }
  }

  return null;
}
