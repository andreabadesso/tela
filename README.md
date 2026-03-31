# Tela

> The AI operating system for companies.

Tela connects AI agents to your tools, knowledge, and workflows — so every role in the company has an intelligent layer operating alongside them. Built for enterprise deployment with governed MCP access, role-based permissions, and per-user audit trails.

Built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents/claude-agent-sdk) + [Model Context Protocol](https://modelcontextprotocol.io/).

---

## What it does

- **Multi-agent orchestrator** — specialized agents per role (CTO, Finance, Sales, HR), with intent routing, council mode, and background task delegation
- **Governed MCP access** — role-based permissions on every MCP tool call. A trainee can't see financial data — tools are filtered before the LLM runs
- **Web UI** — React + Shadcn + assistant-ui chat interface with agent selector, thread management, and full admin panel
- **OAuth connection management** — one-click OAuth to Jira, GitHub, Google, Slack. Company-wide, team-scoped, or per-user tokens
- **Pluggable knowledge sources** — Obsidian vaults, filesystem directories, with heading-aware chunking and vector search (ChromaDB)
- **Configurable scheduling** — DB-defined cron jobs with templates. Users create workflows through prompts, not code
- **Notification channels** — Telegram, Slack, email, webhook, in-app. Per-schedule targeting
- **Audit log** — every agent action logged with user identity, tool name, and access decision
- **Budget controls** — per-agent cost tracking with soft warnings and hard stops

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         FRONTEND                              │
│   React + Shadcn/ui + assistant-ui                            │
│   Chat │ Agents │ Connections │ Schedules │ Knowledge │ Admin │
├──────────────────────────────────────────────────────────────┤
│                    API LAYER (Hono + WebSocket)                │
│                 Auth: email/password + API keys + SSO          │
├──────────────────────────────────────────────────────────────┤
│                       ORCHESTRATOR                             │
│   Routes requests → selects agent → manages turns              │
│   Chat mode │ Background tasks │ Council mode (parallel)       │
├──────────────────────────────────────────────────────────────┤
│                 MCP GOVERNANCE GATEWAY                          │
│   Per-user tool filtering │ Data classification │ Rate limits   │
│   Audit logging │ Credential injection │ Policy enforcement     │
├───────────────┬──────────────┬─────────────┬─────────────────┤
│   Jira MCP    │  GitHub MCP  │  ShipLens   │  Custom MCP      │
├───────────────┴──────────────┴─────────────┴─────────────────┤
│                      RBAC ENGINE                               │
│   Users │ Roles │ Teams │ Policies │ Budget │ Approvals        │
├──────────────────────────────────────────────────────────────┤
│                    KNOWLEDGE LAYER                              │
│   Obsidian │ Filesystem │ ChromaDB vector search               │
├──────────────────────────────────────────────────────────────┤
│                     PERSISTENCE                                │
│   SQLite WAL │ Conversations │ Audit │ Policies │ Threads      │
└──────────────────────────────────────────────────────────────┘
```

---

## Quick start

### Development

```bash
# Clone and install
git clone <repo-url>
cd tela
npm install
cd web && npm install && cd ..

# Configure
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY

# Run backend (API + Telegram + cron)
npm run dev          # tsx watch on port 3000

# Run frontend (separate terminal)
cd web && npm run dev   # Vite on port 5173, proxies to backend
```

### Docker (production)

```bash
docker compose up --build
# Frontend + API on http://localhost:3000
# ChromaDB on http://localhost:8000
```

Or with the production compose:

```bash
docker compose -f docker-compose.prod.yml up --build
```

---

## Core concepts

### Agents

Agents are the core unit. Each agent has:

- **System prompt** — with template variables (`{{company_name}}`, `{{today}}`, `{{agent_name}}`)
- **Model** — which Claude model to use (e.g., `claude-sonnet-4-6`)
- **MCP servers** — which connections the agent can access (GitHub, Jira, etc.)
- **Knowledge sources** — which vaults/directories the agent can search and read
- **Max turns** — tool-use loop limit
- **Budget** — cost tracking with soft/hard thresholds

Agents are configured through the web UI or API. The system prompt defines the agent's behavior — no code changes required to create new workflows.

### Orchestrator

The orchestrator routes incoming messages to the right agent:

- **@mention routing** — `@cto what's the sprint status?` routes to the CTO agent
- **Background tasks** — `POST /api/tasks/assign` runs an agent in the background with checkout (prevents double-work)
- **Council mode** — `POST /api/tasks/council` runs multiple agents in parallel on the same input and returns all responses
- **Budget enforcement** — checks cost limits before execution, creates approval records when exceeded

### MCP governance

Every MCP tool call goes through a multi-layer authorization pipeline:

1. **Tool filtering** — allowed/denied tool lists per policy
2. **Write guards** — read-only policies block write operations (pattern-matched)
3. **Data classification** — tools are labeled (public → restricted), users have max clearance
4. **Rate limiting** — per-hour and per-day limits per (user, connection) pair
5. **Credential resolution** — three-tier: user token → team token → company token
6. **Audit logging** — every call logged with identity, tool, decision

Policies are defined per role, team, or user and attached to specific connections.

### Knowledge sources

Knowledge sources are pluggable adapters that give agents access to documents:

**Obsidian adapter** — reads Obsidian vaults with:
- Path scoping (`rootScope`, `allowedPaths`, `deniedPaths`) for multi-tenancy
- Frontmatter parsing (tags, dates, metadata)
- Wikilink extraction
- Optional vector indexing via ChromaDB

**Filesystem adapter** — reads directories of `.md`, `.txt`, `.markdown`, `.mdx` files with ripgrep-powered search (falls back to filesystem walk).

Both adapters expose three tools to agents:
- `search_<source>` — semantic or keyword search
- `read_<source>` — read a specific document
- `list_<source>` — list files in a directory

**Vector search** (optional): files are chunked by markdown headings (max 2000 chars), embedded with `all-MiniLM-L6-v2` (runs locally via ONNX), and stored in ChromaDB. Queries are converted to embeddings and matched by cosine similarity.

### Schedules

Schedules are cron jobs defined in the database. Each schedule has:
- A cron expression
- A prompt (what to tell the agent)
- An optional agent ID
- Notification channels to send the result to

The agent has full tool access during scheduled runs — it can search the vault, check the calendar, query GitHub, etc. Templates are provided for common workflows (morning briefing, weekly review, PR alerts), and users customize the prompt to match their vault structure.

This replaces hardcoded job files — workflows are defined through prompts, not code.

### Notifications

Pluggable notification channels:

| Channel | Transport | Config |
|---------|-----------|--------|
| Telegram | Bot API | `bot_token`, `chat_id` |
| Slack | Webhook / Bot | `webhook_url` or `bot_token` + `channel` |
| Email | SMTP | `host`, `port`, `from`, `to` |
| Webhook | HTTP POST | `url`, `headers` |
| Web | In-app | Stored in DB, polled by frontend |

Channels are created in the admin UI and attached to schedules. The notification filter service learns from user engagement patterns to suppress low-value notifications.

---

## Authentication

Tela supports multiple auth strategies (tried in order):

1. **Session-based** — email/password sign-up, cookie sessions
2. **API key** — `Authorization: Bearer <key>`, created in settings, hashed in DB
3. **Legacy `API_TOKEN`** — environment variable, super-admin fallback
4. **Dev mode** — no auth configured → auto-creates admin user

### RBAC

Built-in roles:

| Role | Access |
|------|--------|
| `admin` | Full platform access |
| `engineering` | GitHub, Jira, CI/CD, monitoring |
| `finance` | Financial systems, budget tools |
| `sales` | CRM, pipeline tools |
| `hr` | People tools |
| `leadership` | Read access to all connections and knowledge |
| `viewer` | Default agent only, no MCP access |

Policies bind roles (or teams, or users) to specific connections with granular controls: allowed/denied tools, data classification limits, rate limits, and read/write access levels.

---

## API reference

All routes under `/api/`. Auth required unless noted.

### Chat & threads

```
POST   /chat                          Send message (routes through orchestrator)
GET    /threads                       List chat threads
POST   /threads                       Create thread
GET    /threads/:id                   Get thread with messages
DELETE /threads/:id                   Delete thread
```

### Agents

```
GET    /agents                        List agents
GET    /agents/:id                    Get agent details
POST   /agents                        Create agent (admin)
PUT    /agents/:id                    Update agent (admin)
DELETE /agents/:id                    Delete agent (admin)
```

### Connections

```
GET    /connections                    List all connections (admin)
POST   /connections                    Create connection (admin)
PUT    /connections/:id                Update connection (admin)
DELETE /connections/:id                Delete connection (admin)
GET    /connections/:id/authorize      Start OAuth flow
GET    /connections/:id/callback       OAuth callback

GET    /my-available-connections       User's accessible connections (RBAC-filtered)
GET    /my-connections                 User's OAuth tokens
POST   /my-connections/:id             Connect user OAuth
DELETE /my-connections/:id             Disconnect user OAuth
```

### Knowledge sources

```
GET    /knowledge                      List sources
POST   /knowledge                      Create source (admin)
PUT    /knowledge/:id                  Update source (admin)
DELETE /knowledge/:id                  Delete source (admin)
POST   /knowledge/:id/sync             Trigger indexing
POST   /knowledge/search               Search across sources
GET    /knowledge/:id/status            Sync status + doc count
GET    /knowledge/:id/folders           Folder tree
GET    /knowledge/:id/tags              All tags with counts
GET    /knowledge/:id/files             Paginated file list
GET    /knowledge/:id/file              Read specific file
```

### Schedules

```
GET    /schedules                      List schedules
POST   /schedules                      Create schedule (admin)
PUT    /schedules/:id                  Update schedule (admin)
DELETE /schedules/:id                  Delete schedule (admin)
POST   /schedules/:id/run              Run now
GET    /schedules/:id/history           Run history
GET    /schedule-templates              Available templates
```

### Orchestrator

```
POST   /tasks/assign                   Assign background task to agent
POST   /tasks/council                  Run multiple agents in parallel
GET    /approvals                      List pending approvals
POST   /approvals/:id                  Approve or reject
```

### Notifications

```
GET    /notifications/channels         List channels
POST   /notifications/channels         Create channel (admin)
PUT    /notifications/channels/:id     Update channel (admin)
DELETE /notifications/channels/:id     Delete channel (admin)
POST   /notifications/channels/:id/test  Test channel
POST   /notifications/send              Send to specific channels
```

### Admin

```
GET    /admin/users                    List users
POST   /admin/users                    Create user
PUT    /admin/users/:id                Update user
DELETE /admin/users/:id                Delete user
GET    /admin/roles                    List roles
POST   /admin/roles                    Create role
PUT    /admin/roles/:id                Update role
GET    /admin/policies                 List MCP policies
POST   /admin/policies                 Create policy
DELETE /admin/policies/:id             Delete policy
GET    /audit                          Query audit log (paginated, filtered)
POST   /audit/export                   Export audit log
```

### Auth (public)

```
POST   /auth/sign-up/email             Create account
POST   /auth/sign-in/email             Sign in
GET    /auth/get-session               Current session
POST   /auth/sign-out                  Sign out
```

### System

```
GET    /health                         Health check (public)
GET    /settings                       Get all settings
PUT    /settings/:key                  Update setting (admin)
GET    /setup/status                   Onboarding completion status
POST   /setup/complete                 Mark setup complete
```

---

## Database

SQLite in WAL mode. Migrations run automatically on startup.

### Key tables

| Table | Purpose |
|-------|---------|
| `agents` | Agent configurations (prompt, model, MCP servers, knowledge sources) |
| `connections` | MCP server connections (type, config, encrypted credentials) |
| `knowledge_sources` | Knowledge adapter configs (vault path, scope, sync status) |
| `schedules` | Cron job definitions (expression, prompt, agent, channels) |
| `users` | User accounts |
| `roles` / `user_roles` | Role definitions and assignments |
| `teams` / `user_teams` | Team structure |
| `mcp_policies` | Per-role/team/user MCP access rules |
| `knowledge_policies` | Per-role/team/user knowledge access rules |
| `agent_policies` | Per-role/team/user agent access rules |
| `conversations` | Message history with token counts |
| `chat_threads` / `chat_messages` | Persistent chat threads |
| `audit_log` | Every agent action with identity and decision |
| `job_runs` | Schedule execution history |
| `notification_channels` | Channel configs |
| `user_api_keys` | Hashed API keys |
| `user_connections` | Per-user OAuth tokens |
| `approvals` | Budget/permission approval requests |

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | Claude API key |
| `VAULT_PATH` | No | Path to knowledge vault (default: `./vault`) |
| `PORT` | No | API server port (default: `3000`) |
| `TZ` | No | Timezone for cron jobs (default: `America/Sao_Paulo`) |
| `API_TOKEN` | No | Bearer token for API auth (legacy fallback) |
| `ENCRYPTION_KEY` | No | 32-byte hex for OAuth token encryption (auto-generated if empty) |

### Telegram (optional)

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Chat ID for message routing |

### Google (optional)

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client for Calendar + Gmail |
| `GOOGLE_CLIENT_SECRET` | OAuth secret |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL |
| `GOOGLE_SSO_CLIENT_ID` | Separate client for Workspace SSO |
| `GOOGLE_SSO_CLIENT_SECRET` | SSO secret |

### Engineering integrations (optional)

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub personal access token |
| `GITHUB_ORG` | GitHub organization |
| `GITHUB_REPOS` | Comma-separated repo list |
| `JIRA_BASE_URL` | e.g., `https://company.atlassian.net` |
| `JIRA_API_TOKEN` | Jira API token |
| `JIRA_USER_EMAIL` | Jira account email |
| `SHIPLENS_URL` | ShipLens MCP server URL |
| `SHIPLENS_API_KEY` | ShipLens API key |

### Vector search (optional)

| Variable | Description |
|---|---|
| `CHROMA_URL` | ChromaDB URL (default: `http://localhost:8000`) |

### Git sync (optional)

| Variable | Description |
|---|---|
| `GIT_REMOTE_URL` | Remote for vault sync (e.g., `git@github.com:user/vault.git`) |

---

## Project structure

```
src/
├── index.ts                  Entry point — initializes all services
├── agent.ts                  Core agent with vault tools
├── config/env.ts             Environment configuration
├── types/index.ts            Shared TypeScript types
│
├── api/
│   ├── server.ts             Hono server, route registration, static serving
│   ├── middleware.ts          Auth middleware (session → API key → legacy → dev)
│   ├── ws.ts                 WebSocket upgrade handler
│   └── routes/               One file per resource (see API reference)
│
├── orchestrator/
│   ├── index.ts              Message routing, task assignment, council mode
│   └── tools.ts              Orchestrator-level MCP tool definitions
│
├── knowledge/
│   ├── manager.ts            Adapter registry, cross-source search
│   ├── types.ts              KnowledgeAdapter interface
│   ├── chunker.ts            Heading-aware markdown chunking for vector indexing
│   └── adapters/
│       ├── obsidian.ts       Obsidian vault adapter (path scoping, tags, wikilinks)
│       └── filesystem.ts     Generic directory adapter (ripgrep search)
│
├── services/
│   ├── agent-service.ts      Multi-agent execution with per-agent MCP + knowledge
│   ├── mcp-gateway.ts        Authorization pipeline for MCP tool calls
│   ├── mcp-registry.ts       MCP server connection pool + health monitoring
│   ├── database.ts           SQLite WAL with migration runner
│   ├── rbac.ts               Role-based access control resolution
│   ├── encryption.ts         AES-256-GCM for credential storage
│   ├── git.ts                Vault git sync with batched commits
│   ├── vector-store.ts       ChromaDB integration (per-source collections)
│   ├── telegram.ts           Telegram Bot API (grammy)
│   ├── google-auth.ts        OAuth 2.0 token management
│   ├── calendar.ts           Google Calendar API
│   ├── gmail.ts              Gmail API
│   ├── github.ts             GitHub REST API (octokit)
│   ├── jira.ts               Jira REST API
│   ├── shiplens.ts           ShipLens MCP client
│   ├── transcript.ts         Meeting transcript processing
│   ├── knowledge.ts          URL ingestion (fetch → parse → vault)
│   ├── pattern-learning.ts   Behavioral analytics
│   ├── notification-filter.ts Smart notification suppression
│   ├── response-collector.ts  Batch message collection (e.g., EOD flow)
│   └── health.ts             Health check server
│
├── notifications/
│   ├── manager.ts            Channel registry, broadcast, test
│   ├── types.ts              NotificationChannel interface
│   └── channels/             telegram, slack, email, webhook, web
│
├── jobs/
│   ├── registry.ts           Cron scheduler (node-cron, timezone-aware)
│   └── index.ts              Re-exports registry
│
├── handlers/                 Telegram command handlers (/todo, /search, /prep, etc.)
├── tools/vault.ts            Vault MCP tools (read, write, search, list, append)
├── auth/index.ts             better-auth config (optional)
└── migrations/               SQL schema files (001–009)

web/                          React frontend
├── src/
│   ├── pages/                Chat, Agents, Connections, Schedules, Knowledge, Admin
│   ├── components/           UI primitives (shadcn), chat components, layout
│   └── lib/                  API client, auth, WebSocket, assistant-ui runtime
├── package.json              React 19, Vite, Tailwind v4, assistant-ui
└── vite.config.ts            Dev proxy to backend
```

---

## Extending Tela

### Add a knowledge source adapter

Implement the `KnowledgeAdapter` interface in `src/knowledge/adapters/`:

```typescript
import type { KnowledgeAdapter, KnowledgeDocument, SyncResult } from '../types.js';

export class NotionAdapter implements KnowledgeAdapter {
  id: string;
  type = 'notion';

  async search(query: string): Promise<KnowledgeDocument[]> { ... }
  async read(path: string): Promise<KnowledgeDocument> { ... }
  async list(directory?: string): Promise<string[]> { ... }
  async sync(): Promise<SyncResult> { ... }
  getStatus() { ... }
}
```

Register it in `src/index.ts` alongside the obsidian/filesystem adapters.

### Add a notification channel

Create a new channel in `src/notifications/channels/`:

```typescript
import type { NotificationChannel, NotificationMessage } from '../types.js';

export class DiscordChannel implements NotificationChannel {
  async send(message: NotificationMessage): Promise<void> { ... }
  async test(): Promise<boolean> { ... }
}
```

### Add a Telegram command

Add a handler in `src/handlers/` and register it in `src/handlers/index.ts`:

```typescript
export async function handleMyCommand(text: string, messageId: number, ...deps): Promise<void> {
  // ...
}
```

### Add an API route

Create a route file in `src/api/routes/` and register it in `src/api/server.ts`.

---

## Deployment checklist

- [ ] Set `ANTHROPIC_API_KEY`
- [ ] Set `ENCRYPTION_KEY` (32-byte hex) for credential encryption
- [ ] Configure auth (API_TOKEN or sign-up flow)
- [ ] Enable HTTPS via reverse proxy (nginx/Caddy)
- [ ] Set `NODE_ENV=production`
- [ ] Set up volume backups for `agent.db` and vault data
- [ ] Configure at least one notification channel
- [ ] Review default roles and create MCP policies
- [ ] Test OAuth flows for each connection type
- [ ] Monitor `/api/health` endpoint
- [ ] Set up ChromaDB persistence if using vector search

---

## Tech stack

**Backend**: Node.js 22, TypeScript, Hono, better-sqlite3, grammy, node-cron, @anthropic-ai/claude-agent-sdk, @modelcontextprotocol/sdk, @octokit/rest, googleapis, chromadb

**Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui, @assistant-ui/react, TanStack React Query, React Router v7

**Infrastructure**: Docker, SQLite WAL, ChromaDB, Git

---

## License

See LICENSE file.
