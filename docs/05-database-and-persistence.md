# Database & Persistence

Tela uses SQLite with WAL (Write-Ahead Logging) mode as its primary database, with a migration system for schema evolution.

## Database Engine

- **SQLite** via `better-sqlite3` — synchronous, embedded, no external process
- **WAL mode** — Concurrent reads during writes, better performance
- **Location** — `agent.db` in project root (configurable)
- **Migration path** — Postgres evaluated at load test threshold (p99 latency > 100ms)

## Migration System

Schema changes are managed through numbered SQL files in `src/migrations/`:

| Migration | Description |
|-----------|-------------|
| 001 | Core tables: agents, connections, knowledge_sources, schedules |
| 002 | Chat threads and messages |
| 003 | Conversations (legacy log) |
| 004 | Job runs, notification channels |
| 005 | Users, roles, teams, RBAC tables |
| 006 | MCP policies, knowledge policies, agent policies |
| 007 | User connections (delegated tokens) |
| 008 | Tool classifications |
| 009 | Cost events, budget policies, approvals |
| 010 | Agent runs (runtime execution tracking) |
| 011 | Agent memory |
| 012 | Conversations enhancement |
| 013 | Communication channels and threads |

Migrations run automatically on startup. Each migration is idempotent.

## Core Tables

### Agents

```sql
agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  model           TEXT DEFAULT 'sonnet',
  system_prompt   TEXT,
  mcp_servers     TEXT,  -- JSON array of connection IDs
  knowledge_sources TEXT, -- JSON array of source IDs
  max_tokens      INTEGER DEFAULT 8192,
  is_default      INTEGER DEFAULT 0,
  created_at      TEXT,
  updated_at      TEXT
)
```

### Connections

```sql
connections (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,  -- 'jira', 'github', 'google', 'slack', 'mcp', etc.
  config          TEXT,           -- JSON: endpoint, scopes, etc.
  credentials     TEXT,           -- Encrypted (AES-256-GCM)
  token_strategy  TEXT DEFAULT 'company',  -- 'company' or 'delegated'
  status          TEXT DEFAULT 'disconnected',
  created_at      TEXT,
  updated_at      TEXT
)
```

### Knowledge Sources

```sql
knowledge_sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,  -- 'obsidian', 'filesystem', 'notion', 'confluence'
  config          TEXT,           -- JSON: path, filters, sync options
  sync_status     TEXT DEFAULT 'pending',
  last_synced     TEXT,
  document_count  INTEGER DEFAULT 0,
  created_at      TEXT,
  updated_at      TEXT
)
```

### Schedules

```sql
schedules (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  agent_id        TEXT REFERENCES agents(id),
  channels        TEXT,           -- JSON array of notification channel IDs
  enabled         INTEGER DEFAULT 1,
  timezone        TEXT DEFAULT 'America/Sao_Paulo',
  created_at      TEXT,
  updated_at      TEXT
)
```

## Auth & RBAC Tables

### Users

```sql
users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  name            TEXT,
  image           TEXT,
  onboarded       INTEGER DEFAULT 0,
  created_at      TEXT,
  updated_at      TEXT
)
```

### Roles

```sql
roles (
  id              TEXT PRIMARY KEY,
  name            TEXT UNIQUE NOT NULL,  -- admin, engineering, finance, sales, hr, leadership, viewer
  description     TEXT,
  created_at      TEXT
)
```

### Teams & Membership

```sql
teams (
  id              TEXT PRIMARY KEY,
  name            TEXT UNIQUE NOT NULL,
  description     TEXT,
  created_at      TEXT
)

user_roles (user_id TEXT, role_id TEXT, PRIMARY KEY (user_id, role_id))
user_teams (user_id TEXT, team_id TEXT, PRIMARY KEY (user_id, team_id))
```

### User API Keys

```sql
user_api_keys (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id),
  prefix          TEXT NOT NULL,    -- Visible portion for identification
  key_hash        TEXT NOT NULL,    -- Hashed for storage
  name            TEXT,
  last_used       TEXT,
  created_at      TEXT,
  expires_at      TEXT
)
```

## Governance Tables

### MCP Policies

```sql
mcp_policies (
  id                    TEXT PRIMARY KEY,
  principal_type        TEXT NOT NULL,  -- 'role', 'team', 'user'
  principal_id          TEXT NOT NULL,
  connection_id         TEXT REFERENCES connections(id),
  access_level          TEXT NOT NULL,  -- 'read', 'write', 'none'
  allowed_tools         TEXT,           -- JSON array
  denied_tools          TEXT,           -- JSON array
  max_data_classification TEXT,
  rate_limit_per_hour   INTEGER,
  rate_limit_per_day    INTEGER,
  created_at            TEXT,
  updated_at            TEXT,
  UNIQUE(principal_type, principal_id, connection_id)
)
```

### Knowledge & Agent Policies

Follow the same pattern as MCP policies with `principal_type`, `principal_id`, and resource ID, plus `access_level`.

### Tool Classifications

```sql
mcp_tool_classifications (
  id              TEXT PRIMARY KEY,
  connection_id   TEXT REFERENCES connections(id),
  tool_name       TEXT NOT NULL,
  classification  TEXT NOT NULL,  -- 'public', 'internal', 'confidential', 'restricted'
  UNIQUE(connection_id, tool_name)
)
```

## Operational Tables

### Audit Log

```sql
audit_log (
  id              TEXT PRIMARY KEY,
  timestamp       TEXT NOT NULL,
  user_id         TEXT,
  agent_id        TEXT,
  action          TEXT NOT NULL,
  connection_id   TEXT,
  tool_name       TEXT,
  access_decision TEXT,  -- 'allowed', 'denied', 'rate_limited'
  details         TEXT,  -- JSON: input, output, metadata
  created_at      TEXT
)
```

### Cost Events

```sql
cost_events (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT,
  user_id         TEXT,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  cost_cents      REAL NOT NULL,
  tokens_out_reserved INTEGER,
  tokens_out_actual   INTEGER,
  session_id      TEXT,
  created_at      TEXT
)
```

### Budget Policies

```sql
budget_policies (
  id              TEXT PRIMARY KEY,
  scope_type      TEXT NOT NULL,  -- 'agent', 'user', 'team', 'role', 'global'
  scope_id        TEXT,
  budget_cents    REAL NOT NULL,
  period          TEXT NOT NULL,  -- 'daily', 'weekly', 'monthly'
  soft_threshold  REAL DEFAULT 0.8,  -- Warning at 80%
  hard_threshold  REAL DEFAULT 1.0,  -- Stop at 100%
  created_at      TEXT
)
```

### Approvals

```sql
approvals (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,  -- 'budget', 'batch', 'tool'
  requester_id    TEXT,
  details         TEXT,  -- JSON
  status          TEXT DEFAULT 'pending',  -- 'pending', 'approved', 'denied'
  decided_by      TEXT,
  decided_at      TEXT,
  created_at      TEXT
)
```

### Agent Runs

```sql
agent_runs (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT REFERENCES agents(id),
  user_id         TEXT,
  runtime         TEXT NOT NULL,  -- 'in-process', 'agent-os', 'docker'
  status          TEXT NOT NULL,  -- 'pending', 'running', 'completed', 'failed', 'cancelled'
  input           TEXT,
  output          TEXT,
  container_id    TEXT,
  resource_usage  TEXT,  -- JSON: cpu, memory, duration
  created_at      TEXT,
  completed_at    TEXT
)
```

### Agent Memory

```sql
agent_memories (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  user_id         TEXT,
  scope           TEXT DEFAULT 'user',  -- 'global' or 'user'
  type            TEXT NOT NULL,  -- 'user', 'feedback', 'project', 'reference', 'preference'
  name            TEXT NOT NULL,
  description     TEXT,
  content         TEXT NOT NULL,
  created_at      TEXT,
  updated_at      TEXT
)

agent_behavior_config (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  config          TEXT NOT NULL,  -- JSON: tone, language, verbosity, etc.
  created_at      TEXT,
  updated_at      TEXT,
  UNIQUE(agent_id, user_id)
)
```

### Task Checkouts

```sql
task_checkouts (
  id              TEXT PRIMARY KEY,
  task_ref        TEXT NOT NULL,
  agent_id        TEXT,
  session_id      TEXT,
  status          TEXT DEFAULT 'active',
  checked_out_at  TEXT,
  completed_at    TEXT,
  UNIQUE(task_ref, status)  -- Only one active checkout per task
)
```

### Communication Channels

```sql
communication_channels (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,  -- 'telegram', 'slack', 'github', 'jira'
  config          TEXT,
  status          TEXT DEFAULT 'active',
  created_at      TEXT
)

channel_threads (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT REFERENCES communication_channels(id),
  external_id     TEXT,  -- Platform-specific thread/conversation ID
  context         TEXT,  -- JSON metadata
  created_at      TEXT,
  updated_at      TEXT
)
```

## Chat Tables

```sql
chat_threads (
  id              TEXT PRIMARY KEY,
  title           TEXT,
  agent_id        TEXT REFERENCES agents(id),
  user_id         TEXT,
  created_at      TEXT,
  updated_at      TEXT
)

chat_messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT REFERENCES chat_threads(id),
  role            TEXT NOT NULL,  -- 'user', 'assistant'
  content         TEXT NOT NULL,
  tool_calls      TEXT,  -- JSON
  tokens          INTEGER,
  model           TEXT,
  created_at      TEXT
)
```

## Encryption

Credentials stored in the `connections` table are encrypted using AES-256-GCM:

- **Key** — `ENCRYPTION_KEY` environment variable (32-byte hex), auto-generated if empty
- **Per-value IV** — Each encrypted value gets a unique initialization vector
- **Key rotation** — Admin UI supports re-encrypting all credentials with a new key

## Job Tracking

```sql
job_runs (
  id              TEXT PRIMARY KEY,
  job_name        TEXT NOT NULL,
  schedule_id     TEXT,
  status          TEXT NOT NULL,  -- 'running', 'success', 'error'
  output          TEXT,
  error           TEXT,
  started_at      TEXT,
  completed_at    TEXT
)
```

## Notification Channels

```sql
notification_channels (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,  -- 'telegram', 'slack', 'email', 'webhook', 'web'
  config          TEXT,           -- JSON: token, chat_id, webhook_url, etc.
  enabled         INTEGER DEFAULT 1,
  created_at      TEXT
)
```
