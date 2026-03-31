# Architecture — Tela

> The AI operating system for companies.

---

## Vision

Um sistema operacional para empresas, powered by AI agents. Conecta a qualquer fonte de conhecimento, qualquer ferramenta, qualquer workflow. Cada role na empresa (CTO, CEO, CFO, COO) tem seus agentes especializados, todos operando sobre uma base unificada de conhecimento e integrações.

Não é um chatbot. Não é um dashboard. É a camada inteligente que opera a empresa.

---

## Design Principles

1. **Unopinionated by default** — sem cron jobs hardcoded, sem roles predefinidos. Tudo configurável pela interface
2. **Knowledge-agnostic** — Obsidian, Notion, Confluence, Google Drive, filesystem, qualquer coisa. A knowledge layer é um plugin, não hardcoded
3. **MCP-native** — toda integração é um MCP server. OAuth gerenciado pela plataforma, não por env vars
4. **Multi-agent from the start** — um orchestrator coordena agentes especializados, não um mega-agent que faz tudo
5. **Frontend-first configuration** — tudo que hoje é .env ou código vira UI: connections, agents, schedules, permissions

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                              │
│  React + Shadcn/ui                                           │
│  ┌──────────┬──────────┬───────────┬──────────┬───────────┐ │
│  │ Chat     │ Agents   │ Connections│ Schedules│ Knowledge │ │
│  │ Console  │ Config   │ (OAuth)   │ (Cron)   │ Sources   │ │
│  └──────────┴──────────┴───────────┴──────────┴───────────┘ │
├─────────────────────────────────────────────────────────────┤
│                     API LAYER (REST/WS)                       │
├─────────────────────────────────────────────────────────────┤
│                    ORCHESTRATOR                               │
│  Routes requests → selects agent(s) → manages turns          │
│  Claude Agent SDK (sub-agents + Agent Teams)                 │
├──────────────┬──────────────┬──────────────┬────────────────┤
│  CTO Agent   │  CEO Agent   │  CFO Agent   │  Custom Agent  │
│  (eng tools) │  (all tools) │  (fin tools) │  (user-defined)│
├──────────────┴──────────────┴──────────────┴────────────────┤
│                   MCP GATEWAY                                │
│  Connection management, OAuth, RBAC, audit logging           │
│  ┌────────┬────────┬────────┬────────┬────────┬──────────┐  │
│  │ Jira   │ GitHub │ Slack  │ Calendar│ CRM   │ Custom   │  │
│  │ MCP    │ MCP    │ MCP    │ MCP    │ MCP    │ MCP      │  │
│  └────────┴────────┴────────┴────────┴────────┴──────────┘  │
├─────────────────────────────────────────────────────────────┤
│                  KNOWLEDGE LAYER                              │
│  Pluggable adapters: Obsidian, Notion, Confluence, FS, S3   │
│  Vector search (ChromaDB / pgvector)                         │
│  Metadata, provenance, lifecycle management                  │
├─────────────────────────────────────────────────────────────┤
│                   PERSISTENCE                                │
│  SQLite/Postgres: conversations, agent config, schedules,    │
│  connection state, audit logs, knowledge index               │
└─────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Frontend (Web UI)

**Stack:** React + Shadcn/ui (or similar)

**Pages:**

| Page | What it does |
|---|---|
| **Chat Console** | Talk to any agent. Switch between agents. See tool calls, reasoning, actions in real-time |
| **Agents** | Create, configure, enable/disable agents. Set model, system prompt, available MCP servers, permissions |
| **Connections** | Add integrations via OAuth flow. Status dashboard (connected/disconnected). Manage credentials without touching env vars |
| **Schedules** | Create cron jobs visually. Assign to agents. Enable/disable. View history/output |
| **Knowledge Sources** | Connect knowledge bases (Obsidian vault, Notion workspace, Confluence space, folder). Manage indexing, metadata, sync status |
| **Audit Log** | Every agent action logged. What was accessed, what was changed, by which agent, when |
| **Settings** | Global: default model, timezone, notification channels (Telegram, Slack, email) |

**No hardcoded cron jobs.** The 12 jobs in current code become templates that a user can enable/configure from the UI:

```
Morning Briefing Template:
  - Schedule: configurable (default 8:00 AM)
  - Agent: selectable (default: CTO Agent)
  - Notification: selectable (Telegram, Slack, email)
  - Prompt: editable
  - Enabled: toggle
```

### 2. MCP Gateway

**The problem today:** credentials are in .env, each service is a custom TypeScript class, adding a new integration means writing code.

**The solution:** an MCP gateway that manages connections with OAuth.

**Options evaluated:**

| Solution | What it does | Fit |
|---|---|---|
| **Deco Host** | One-click MCP server deploy, credential management, unified endpoint | Best for managed/hosted |
| **Obot MCP Gateway** | Open-source, RBAC, audit logging, Kubernetes | Best for self-hosted enterprise |
| **Open WebUI MCP** | Per-user OAuth, tool sync, admin management | Good if using Open WebUI as frontend |
| **LibreChat MCP** | OAuth flows, connection status tracking | Good if using LibreChat as frontend |
| **Custom (our own)** | Thin layer: stores OAuth tokens in DB, proxies to MCP servers | Full control, more work |

**Recommendation:** start with **custom thin layer** that:
- Stores OAuth tokens encrypted in DB
- Has a UI page to initiate OAuth flows (click "Connect Jira" → OAuth → done)
- Proxies requests to MCP servers with injected auth
- Later evaluate Deco Host or Obot if complexity justifies

**Key integrations (MCP servers):**

| Integration | MCP Server | OAuth |
|---|---|---|
| Jira/Confluence | Atlassian Remote MCP Server (official) | Atlassian OAuth 2.0 |
| GitHub | GitHub MCP Server (official) | GitHub OAuth App |
| Slack | Community MCP server or custom | Slack OAuth |
| Google Calendar/Gmail | Custom (googleapis) | Google OAuth 2.0 |
| Notion | Community MCP server | Notion OAuth |
| ShipLens | Custom MCP server (already exists) | API key |
| Salesforce/HubSpot | Community MCP servers | OAuth |

### 3. Multi-Agent Architecture

**Current:** single CtoAgent class does everything.

**Target:** orchestrator + specialized agents.

Using Claude Agent SDK's sub-agent pattern:

```
Orchestrator (receives all requests)
├── routes to appropriate agent based on intent
├── can spawn multiple agents in parallel
└── aggregates results

CTO Agent (engineering)
├── MCP: Jira, GitHub, CI/CD, Monitoring, ShipLens
├── Knowledge: engineering docs, architecture, ADRs
└── Can do: sprint status, PR review, incident triage, DORA metrics

CEO Agent (everything)
├── MCP: all connections
├── Knowledge: all sources
└── Can do: company overview, board prep, strategic questions

CFO Agent (finance)
├── MCP: Finance system, BI, Budget
├── Knowledge: financial docs, reports
└── Can do: burn rate, forecast, cost analysis

Custom Agent (user-defined)
├── MCP: user-selected connections
├── Knowledge: user-selected sources
└── Can do: whatever the user configures
```

**Agent definition in the UI:**

```json
{
  "id": "cto-agent",
  "name": "CTO Agent",
  "model": "claude-opus-4-6",
  "systemPrompt": "You are a CTO assistant for {{company_name}}...",
  "mcpServers": ["jira", "github", "shiplens", "monitoring"],
  "knowledgeSources": ["engineering-docs", "architecture"],
  "permissions": {
    "canWrite": true,
    "canExecute": false,
    "requiresApproval": ["delete", "deploy"]
  },
  "maxTurns": 20
}
```

**No hardcoded agents.** The CTO agent is a template. User creates agents from scratch or from templates.

### 4. Knowledge Layer

**Current:** Obsidian vault accessed directly via filesystem tools + ChromaDB for vector search.

**Target:** pluggable adapters that normalize any knowledge source into a unified interface.

```typescript
interface KnowledgeAdapter {
  id: string;
  name: string;
  type: 'obsidian' | 'notion' | 'confluence' | 'filesystem' | 's3' | 'custom';

  // Read operations
  search(query: string, options?: SearchOptions): Promise<Document[]>;
  read(path: string): Promise<Document>;
  list(directory?: string): Promise<string[]>;

  // Write operations (optional)
  write?(path: string, content: string): Promise<void>;
  append?(path: string, content: string): Promise<void>;

  // Sync
  sync(): Promise<SyncResult>;
  getLastSyncTime(): Date;

  // Metadata
  getMetadata(path: string): Promise<DocumentMetadata>;
}
```

**Adapters to build:**

| Adapter | How it connects | Write support |
|---|---|---|
| **Obsidian** | Filesystem + git sync (already built) | Yes |
| **Notion** | Notion API | Yes |
| **Confluence** | Atlassian API / MCP | Yes |
| **Filesystem** | Direct file access | Yes |
| **S3/GCS** | Cloud storage API | Yes |
| **Google Drive** | Google Drive API | Yes |
| **Web (URL)** | Scrape + index (already built as knowledge ingestion) | No |

**Vector search:** remains ChromaDB (or pgvector if moving to Postgres). Each adapter syncs to the vector store. Agent queries hit vector search first, then falls back to adapter-specific search.

**In the UI:** user adds a knowledge source, configures connection, triggers initial sync, monitors status.

### 5. Persistence

**Current:** SQLite (better-sqlite3) for conversations.

**Target:** same DB also stores:
- Agent configurations
- Connection/OAuth state (tokens encrypted)
- Schedule definitions
- Audit logs
- Knowledge source configs
- Vector store metadata

**SQLite is fine for single-instance.** If scaling to multi-user/multi-tenant, migrate to Postgres.

### 6. Notification Channels

**Current:** Telegram only.

**Target:** pluggable notification channels.

| Channel | Use case |
|---|---|
| **Telegram** | Personal mobile notifications |
| **Slack** | Team notifications |
| **Email** | Async reports, digests |
| **Web UI** | In-app notifications |
| **Webhook** | Custom integrations |

Each schedule job specifies which channel(s) to notify. Agent responses go to the channel where the request originated.

---

## Migration Path from Current Code

### Phase 1: API + Frontend shell (Week 1)

- Extract API layer from current code (Express/Hono)
- Health, agents CRUD, conversations API
- Basic React frontend: chat console + agent config page
- Move hardcoded system prompt to DB-stored agent config
- Keep Telegram as-is (runs in parallel with web UI)

### Phase 2: Connection management (Week 2)

- Build OAuth flow for Jira, GitHub, Google
- Connections page in UI: add, status, remove
- Replace .env-based credentials with DB-stored OAuth tokens
- Convert JiraService, GitHubService to proper MCP servers

### Phase 3: Knowledge adapters (Week 2-3)

- Extract current vault tools into KnowledgeAdapter interface
- Build Notion adapter
- Knowledge Sources page in UI: add source, sync, status
- Vector search across all sources (not just vault)

### Phase 4: Multi-agent (Week 3)

- Orchestrator that routes to specialized agents
- Agent Templates in UI (CTO, CEO, CFO)
- Custom agent creation
- Sub-agent spawning for complex queries

### Phase 5: Schedules + polish (Week 4) ✅

- Move all cron jobs to DB-defined schedules
- Schedules page in UI: create, edit, enable/disable, history
- Audit log page
- Notification channel config

### Phase 6: Enterprise (Weeks 5-8)

Deploy to 140 employees with governed MCP access.

- **Auth**: better-auth + Google Workspace SSO. Session management, API keys.
- **RBAC**: Users, Roles (admin/engineering/finance/sales/hr/leadership/viewer), Teams, permission resolution engine
- **MCP Governance Gateway**: the core — per-user tool filtering, data classification, rate limiting, credential injection, audit logging
- **Per-user connections**: company-wide tokens OR user-delegated OAuth
- **Budget controls**: per-user and per-team spending limits with approval gates
- **Onboarding**: setup wizard for first deploy, employee onboarding flow

---

## MCP Governance Model

When an agent runs on behalf of a user:

```
Effective MCP servers = Agent's configured servers
                      ∩ User's role-permitted servers
                      ∩ Healthy connections

For each tool call:
  1. Check tool-level permission (allowed/denied lists)
  2. Check access level (read vs write)
  3. Check data classification (public/internal/confidential/restricted)
  4. Check rate limit (per user per connection)
  5. Inject correct credentials (company-wide OR user-delegated)
  6. Log to audit trail with user identity
```

**Evaluated [Deco Studio](https://github.com/decocms/studio)** as MCP control plane. Built custom instead because Deco doesn't support per-user tool filtering, user-delegated tokens, or data classification — which are our core requirements.

---

## Tech Stack

| Component | Technology | Why |
|---|---|---|
| **Runtime** | Node.js 22+ | Already using, Agent SDK is JS-native |
| **Agent SDK** | @anthropic-ai/claude-agent-sdk | First-class MCP support, sub-agents |
| **API** | Hono | Lightweight, modern, works in any runtime |
| **Frontend** | React + Vite + Shadcn/ui + assistant-ui | Chat primitives out of the box |
| **Database** | SQLite (better-sqlite3) → Postgres if needed | 140 users is borderline for SQLite writes |
| **Vector Search** | ChromaDB → pgvector later | Already integrated |
| **MCP** | @modelcontextprotocol/sdk | Official SDK for client/server |
| **Auth** | better-auth | SSO/OIDC, Hono adapter, sessions, API keys, MIT |
| **Realtime** | WebSocket | Agent streaming to UI |

---

## What This IS

A self-hosted platform where a company can:
1. Connect their tools (OAuth, one click)
2. Connect their knowledge (any source)
3. Create AI agents for any role
4. **Govern who can access what** (RBAC + MCP policies)
5. Schedule automated workflows
6. Track every action with per-user audit trails
7. Control costs with per-user budgets
8. Operate the company through an intelligent, governed layer

The **governed MCP layer** is what makes it enterprise-ready. The agents are the interface. The MCP servers are the connectors. The RBAC engine is the gatekeeper. The platform ties it all together.

---

## Decisions Made

- [x] Name: **Tela** (Portuguese for "screen" — the layer you interact through)
- [x] MCP strategy: Custom in-process gateway, not Deco Studio
- [x] Auth: better-auth + Google Workspace SSO
- [x] Permission model: Union with deny override
- [ ] License? (open-source, AGPLv3 like Dify? MIT? Source-available?)
- [ ] Database: SQLite for now, benchmark at 140 users, migrate to Postgres if needed
- [ ] Monetization? (self-hosted free, managed cloud paid?)
