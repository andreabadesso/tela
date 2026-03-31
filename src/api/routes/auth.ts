import { Hono } from 'hono';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import path from 'node:path';
import { setCookie, getCookie } from 'hono/cookie';
import type { AuthUser } from '../middleware.js';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'agent.db');

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function getUser(c: { get: (key: string) => unknown }): AuthUser | null {
  return (c.get('user') as AuthUser) ?? null;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const hashBuffer = Buffer.from(hash, 'hex');
  const derived = scryptSync(password, salt, 64);
  return timingSafeEqual(hashBuffer, derived);
}

function createSession(db: Database.Database, userId: string): string {
  const token = randomBytes(32).toString('hex');
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (id, user_id, token, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(id, userId, token, expiresAt);
  return token;
}

export function authRoutes() {
  const app = new Hono();

  // POST /auth/sign-up/email — Create account with email/password
  app.post('/auth/sign-up/email', async (c) => {
    const body = await c.req.json<{ email: string; password: string; name: string }>();
    if (!body.email || !body.password || !body.name) {
      return c.json({ error: 'Email, password, and name are required' }, 400);
    }
    if (body.password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters' }, 400);
    }

    return withDb((db) => {
      // Check if user exists
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(body.email);
      if (existing) {
        return c.json({ error: 'An account with this email already exists' }, 409);
      }

      // Create user
      const userId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO users (id, email, name, status)
        VALUES (?, ?, ?, 'active')
      `).run(userId, body.email, body.name);

      // Store password in accounts table
      const passwordHash = hashPassword(body.password);
      db.prepare(`
        INSERT INTO accounts (id, user_id, provider, provider_account_id, password)
        VALUES (?, ?, 'credential', ?, ?)
      `).run(crypto.randomUUID(), userId, body.email, passwordHash);

      // Assign viewer role
      const viewerRole = db.prepare("SELECT id FROM roles WHERE id = 'viewer'").get() as { id: string } | undefined;
      if (viewerRole) {
        db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, viewerRole.id);
      }

      // Create session
      const token = createSession(db, userId);

      setCookie(c, 'session_token', token, {
        httpOnly: true,
        secure: false, // set true in production
        sameSite: 'Lax',
        maxAge: 7 * 24 * 60 * 60,
        path: '/',
      });

      return c.json({
        user: { id: userId, email: body.email, name: body.name },
        token,
      }, 201);
    });
  });

  // POST /auth/sign-in/email — Sign in with email/password
  app.post('/auth/sign-in/email', async (c) => {
    const body = await c.req.json<{ email: string; password: string }>();
    if (!body.email || !body.password) {
      return c.json({ error: 'Email and password are required' }, 400);
    }

    return withDb((db) => {
      // Find account
      const account = db.prepare(`
        SELECT a.password, u.id, u.email, u.name, u.status
        FROM accounts a
        JOIN users u ON u.id = a.user_id
        WHERE a.provider = 'credential' AND a.provider_account_id = ?
      `).get(body.email) as { password: string; id: string; email: string; name: string; status: string } | undefined;

      if (!account || !account.password) {
        return c.json({ error: 'Invalid email or password' }, 401);
      }

      if (account.status !== 'active') {
        return c.json({ error: 'Account is suspended' }, 403);
      }

      if (!verifyPassword(body.password, account.password)) {
        return c.json({ error: 'Invalid email or password' }, 401);
      }

      // Create session
      const token = createSession(db, account.id);

      setCookie(c, 'session_token', token, {
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
        maxAge: 7 * 24 * 60 * 60,
        path: '/',
      });

      return c.json({
        user: { id: account.id, email: account.email, name: account.name },
        token,
      });
    });
  });

  // GET /auth/get-session — Get current session from cookie
  app.get('/auth/get-session', (c) => {
    const token = getCookie(c, 'session_token');
    if (!token) return c.json({ user: null }, 401);

    return withDb((db) => {
      const session = db.prepare(`
        SELECT s.user_id, s.expires_at, u.email, u.name, u.image
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > datetime('now')
      `).get(token) as { user_id: string; expires_at: string; email: string; name: string; image: string | null } | undefined;

      if (!session) return c.json({ user: null }, 401);

      // Get roles
      const roles = (db.prepare(`
        SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?
      `).all(session.user_id) as { name: string }[]).map(r => r.name);

      return c.json({
        user: {
          id: session.user_id,
          email: session.email,
          name: session.name,
          image: session.image,
          roles: roles.length > 0 ? roles : ['viewer'],
        },
        session: { expiresAt: session.expires_at },
      });
    });
  });

  // POST /auth/sign-out — Destroy session
  app.post('/auth/sign-out', (c) => {
    const token = getCookie(c, 'session_token');
    if (token) {
      withDb((db) => {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      });
    }
    setCookie(c, 'session_token', '', { maxAge: 0, path: '/' });
    return c.json({ ok: true });
  });

  // POST /auth/api-keys - Create a new API key
  app.post('/auth/api-keys', async (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    let body: { name?: string; scopes?: string[]; expiresInDays?: number } = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body is ok
    }
    const name = body.name || 'API Key';
    const scopes = body.scopes || [];
    const expiresInDays = body.expiresInDays;

    // Generate a random API key: tela_<32 random hex chars>
    const rawKey = randomBytes(32).toString('hex');
    const plaintext = `tela_${rawKey}`;
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    const keyPrefix = plaintext.slice(0, 12); // "tela_" + first 7 hex chars

    const id = crypto.randomUUID();
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    withDb((db) => {
      db.prepare(`
        INSERT INTO user_api_keys (id, user_id, name, key_hash, key_prefix, scopes, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, user.id, name, keyHash, keyPrefix, JSON.stringify(scopes), expiresAt);
    });

    return c.json({
      id,
      name,
      key: plaintext, // Only returned once!
      prefix: keyPrefix,
      scopes,
      expiresAt,
      createdAt: new Date().toISOString(),
    }, 201);
  });

  // GET /auth/api-keys - List user's API keys (prefix only, never full key)
  app.get('/auth/api-keys', (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const keys = withDb((db) =>
      db.prepare(`
        SELECT id, name, key_prefix, scopes, last_used_at, expires_at, created_at
        FROM user_api_keys
        WHERE user_id = ?
        ORDER BY created_at DESC
      `).all(user.id) as {
        id: string;
        name: string;
        key_prefix: string;
        scopes: string;
        last_used_at: string | null;
        expires_at: string | null;
        created_at: string;
      }[]
    );

    return c.json(keys.map(k => ({
      ...k,
      scopes: JSON.parse(k.scopes),
    })));
  });

  // DELETE /auth/api-keys/:id - Revoke an API key
  app.delete('/auth/api-keys/:id', (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const keyId = c.req.param('id');
    const result = withDb((db) =>
      db.prepare('DELETE FROM user_api_keys WHERE id = ? AND user_id = ?').run(keyId, user.id)
    );

    if (result.changes === 0) {
      return c.json({ error: 'API key not found' }, 404);
    }

    return c.json({ ok: true });
  });

  // GET /auth/me - Get current user info
  app.get('/auth/me', (c) => {
    const user = getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(user);
  });

  return app;
}
