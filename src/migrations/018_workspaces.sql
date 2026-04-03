-- DevContainer workspaces — persistent development environments

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  container_id TEXT,
  volume_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  port_mappings TEXT NOT NULL DEFAULT '[]',
  insforge_project_id TEXT,
  disk_usage_mb INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_active_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspaces_agent ON workspaces(agent_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);
