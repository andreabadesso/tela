-- Project sessions: each session is one ephemeral agent run (clone → work → push → destroy)
CREATE TABLE project_sessions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  user_id       TEXT NOT NULL REFERENCES users(id),

  status        TEXT NOT NULL DEFAULT 'pending',
  -- 'pending' | 'running' | 'committed' | 'failed' | 'cancelled'

  container_id  TEXT,
  commit_sha    TEXT,
  commit_message TEXT,

  input         TEXT NOT NULL,   -- JSON: the user's message
  output        TEXT,            -- final agent response text
  error         TEXT,

  started_at    TEXT,
  completed_at  TEXT,
  duration_ms   INTEGER,

  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_project ON project_sessions(project_id);
CREATE INDEX idx_sessions_user    ON project_sessions(user_id);
CREATE INDEX idx_sessions_status  ON project_sessions(status);
