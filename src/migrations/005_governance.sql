-- 005_governance.sql: Governance policies, user connections, tool classifications

-- MCP Access Policies (core governance table)
CREATE TABLE IF NOT EXISTS mcp_policies (
  id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'read',
  allowed_tools TEXT,
  denied_tools TEXT,
  max_data_classification TEXT NOT NULL DEFAULT 'internal',
  rate_limit_per_hour INTEGER,
  rate_limit_per_day INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(principal_type, principal_id, connection_id)
);

-- Knowledge Source Access Policies
CREATE TABLE IF NOT EXISTS knowledge_policies (
  id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  knowledge_source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  access_level TEXT NOT NULL DEFAULT 'read',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(principal_type, principal_id, knowledge_source_id)
);

-- Agent Access Policies
CREATE TABLE IF NOT EXISTS agent_policies (
  id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  can_use INTEGER NOT NULL DEFAULT 1,
  can_configure INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(principal_type, principal_id, agent_id)
);

-- Per-user OAuth connections (delegated tokens)
CREATE TABLE IF NOT EXISTS user_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  credentials TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, connection_id)
);

-- MCP tool data classification
CREATE TABLE IF NOT EXISTS mcp_tool_classifications (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  data_classification TEXT NOT NULL DEFAULT 'internal',
  description TEXT,
  UNIQUE(connection_id, tool_name)
);

-- Add token strategy to connections
ALTER TABLE connections ADD COLUMN token_strategy TEXT NOT NULL DEFAULT 'company';

-- Extend audit_log with governance fields
ALTER TABLE audit_log ADD COLUMN connection_id TEXT;
ALTER TABLE audit_log ADD COLUMN tool_name TEXT;
ALTER TABLE audit_log ADD COLUMN access_decision TEXT;
