CREATE TABLE IF NOT EXISTS conversation_summaries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source TEXT NOT NULL,
  summary TEXT NOT NULL,
  covers_from_id INTEGER NOT NULL,
  covers_to_id INTEGER NOT NULL,
  conversation_count INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, source, covers_to_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_summaries_agent_source
  ON conversation_summaries(agent_id, source);
