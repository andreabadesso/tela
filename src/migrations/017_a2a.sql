-- A2A protocol support: task metadata and push notification configs

CREATE TABLE IF NOT EXISTS a2a_tasks (
  id TEXT PRIMARY KEY,
  context_id TEXT,
  skill_id TEXT,
  messages TEXT NOT NULL DEFAULT '[]',
  artifacts TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (id) REFERENCES agent_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context ON a2a_tasks(context_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_skill ON a2a_tasks(skill_id);

CREATE TABLE IF NOT EXISTS a2a_push_configs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  url TEXT NOT NULL,
  token TEXT,
  authentication TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES a2a_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_a2a_push_task ON a2a_push_configs(task_id);
