-- 006_better_auth_compat.sql: Add columns required by better-auth that migration 004 is missing

-- Users: better-auth expects emailVerified (boolean) and image (text)
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN image TEXT;

-- Sessions: better-auth expects ipAddress and userAgent
ALTER TABLE sessions ADD COLUMN ip_address TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;

-- Accounts: better-auth expects idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password
ALTER TABLE accounts ADD COLUMN id_token TEXT;
ALTER TABLE accounts ADD COLUMN access_token_expires_at TEXT;
ALTER TABLE accounts ADD COLUMN refresh_token_expires_at TEXT;
ALTER TABLE accounts ADD COLUMN scope TEXT;
ALTER TABLE accounts ADD COLUMN password TEXT;

-- Verification table for better-auth (email verification, password reset, etc.)
CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed default roles (idempotent via IF NOT EXISTS on unique constraint)
INSERT OR IGNORE INTO roles (id, name, description, is_system) VALUES ('admin', 'admin', 'Full administrative access', 1);
INSERT OR IGNORE INTO roles (id, name, description, is_system) VALUES ('viewer', 'viewer', 'Read-only access', 1);
INSERT OR IGNORE INTO roles (id, name, description, is_system) VALUES ('editor', 'editor', 'Can edit content and manage agents', 1);
