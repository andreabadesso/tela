-- Communication channels: unified bidirectional platform integrations
CREATE TABLE IF NOT EXISTS communication_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'bidirectional',
  agent_id TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'stopped',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Thread mapping: links platform threads to agent conversations
CREATE TABLE IF NOT EXISTS channel_threads (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  platform_thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  chat_thread_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (channel_id) REFERENCES communication_channels(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (chat_thread_id) REFERENCES chat_threads(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_threads_lookup
  ON channel_threads(channel_id, platform_thread_id);

CREATE INDEX IF NOT EXISTS idx_channel_threads_agent
  ON channel_threads(agent_id);

CREATE INDEX IF NOT EXISTS idx_comm_channels_platform
  ON communication_channels(platform);

-- Migrate existing notification_channels into communication_channels
INSERT OR IGNORE INTO communication_channels (id, name, platform, direction, config, enabled, status, created_at, updated_at)
  SELECT id, name, type, 'outbound', config, enabled, 'stopped', created_at, updated_at
  FROM notification_channels;
