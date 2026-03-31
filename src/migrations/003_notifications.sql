CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT,
  title TEXT,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  source TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
