-- 001_initial.sql: Wrap existing tables in IF NOT EXISTS

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  tool_calls TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  output TEXT,
  error TEXT,
  consecutive_failures INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS eod_state (
  date TEXT PRIMARY KEY,
  prompted_at TEXT,
  response_received_at TEXT,
  response TEXT,
  processed_at TEXT,
  updates_made TEXT
);
