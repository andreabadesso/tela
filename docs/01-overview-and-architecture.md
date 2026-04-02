# Overview & Architecture

## What is Tela?

Tela is an AI operating system for companies. It provides a platform where organizations can deploy specialized AI agents — each with their own role, tools, knowledge access, and permissions — that work together to augment company operations.

At its core, Tela is:
- **A multi-agent orchestrator** that routes work to the right agent
- **An MCP governance layer** that controls what tools each agent can access, per user
- **A knowledge platform** that connects agents to company knowledge bases
- **An enterprise platform** with RBAC, audit logging, and budget controls

## Design Principles

### Unopinionated by Default
No hardcoded agent personas. Agents, their system prompts, tools, and knowledge sources are all configured through the UI. You can create a CTO agent, a support agent, or anything else.

### Knowledge-Agnostic
The knowledge layer supports multiple adapters (Obsidian vaults, filesystems, with Notion and Confluence planned). All sources are unified through a common interface and indexed in a vector store.

### MCP-Native
All external tool access goes through the Model Context Protocol. Connections to Jira, GitHub, Google, Slack, and custom services are all MCP servers. The governance gateway wraps every MCP call with authorization, rate limiting, and audit logging.

### Multi-Agent from the Start
The orchestrator can route messages to different agents, run multiple agents on the same query (council mode), or assign background tasks to agents. Agents can call each other via the `ask_agent` MCP tool.

### Frontend-First Configuration
Everything is configurable from the web UI — agents, connections, schedules, policies, knowledge sources. No code changes needed to add a new agent or integration.

## Tech Stack

### Backend
| Technology | Purpose |
|-----------|---------|
| Node.js 22 + TypeScript | Runtime and language |
| Claude Agent SDK | Agent execution with MCP support |
| MCP SDK | Model Context Protocol client/server |
| Hono | Lightweight HTTP framework |
| better-sqlite3 | SQLite with WAL mode |
| better-auth | Authentication (SSO, API keys) |
| ChromaDB | Vector search for knowledge |
| Grammy | Telegram bot framework |
| node-cron | Scheduled job execution |
| Zod | Runtime validation |

### Frontend
| Technology | Purpose |
|-----------|---------|
| React 19 | UI framework |
| Vite | Build tool |
| Tailwind CSS v4 | Styling |
| Shadcn/ui | Component library |
| assistant-ui | Headless chat primitives |
| TanStack Query | Server state management |
| React Router v7 | Routing |

### Infrastructure
| Technology | Purpose |
|-----------|---------|
| Docker + Compose | Containerization |
| Nix Flakes | Reproducible builds |
| SQLite WAL | Primary database |
| ChromaDB | Vector database |

## High-Level Architecture

### Request Flow

1. **User sends message** via Web UI (REST/WebSocket) or Telegram
2. **Auth middleware** resolves user identity (session, API key, or legacy token)
3. **Orchestrator** determines which agent should handle the message (explicit mention, keyword routing, or default agent)
4. **Agent runtime** executes the agent with:
   - System prompt (with variable interpolation)
   - Conversation history
   - Injected memories and user context
   - Governed MCP tools (filtered by user permissions)
   - Knowledge search tools
5. **MCP Gateway** intercepts every tool call:
   - Checks RBAC policies (role/team/user permissions)
   - Enforces rate limits
   - Injects credentials (company or user-delegated)
   - Logs to audit trail
6. **Response streams** back to the user in real-time via WebSocket

### Multi-Agent Modes

| Mode | Description |
|------|-------------|
| **Direct** | Message routed to a single agent |
| **Council** | Multiple agents process the same query in parallel, results synthesized |
| **Background** | Task assigned to agent, runs asynchronously, returns run ID |
| **Agent-to-Agent** | Agents call each other via `ask_agent` MCP tool |

### Key Subsystems

```
┌─────────────────────────────────────────────────────────┐
│                      API Layer (Hono)                    │
│  REST endpoints + WebSocket streaming + Auth middleware   │
├─────────────┬──────────────┬──────────────┬─────────────┤
│ Orchestrator│  RBAC Engine │  Scheduling  │  Audit Log  │
├─────────────┴──────┬───────┴──────────────┴─────────────┤
│               Agent Service                              │
│  System prompt · History · Memory injection · Streaming  │
├────────────────────┬────────────────────────────────────┤
│   MCP Gateway      │      Knowledge Manager             │
│  Policy check      │   Adapter registry                 │
│  Rate limiting     │   Vector search (ChromaDB)         │
│  Credential inject │   Source attribution               │
│  Audit logging     │   Heading-aware chunking           │
├────────────────────┴────────────────────────────────────┤
│               Runtime Layer                              │
│  In-Process · Agent OS (V8 isolates) · Docker           │
├─────────────────────────────────────────────────────────┤
│               Persistence                                │
│  SQLite WAL · Migrations · Encrypted credentials         │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
tela/
├── src/
│   ├── index.ts              # Server entry point
│   ├── agent-worker.ts       # Isolated agent worker (Docker/Agent OS)
│   ├── api/
│   │   ├── server.ts         # Hono app, middleware, routes
│   │   ├── middleware.ts      # Auth pipeline
│   │   ├── ws.ts             # WebSocket handler
│   │   └── routes/           # One file per resource (20 route files)
│   ├── services/             # Business logic (23 services)
│   ├── orchestrator/         # Multi-agent routing & coordination
│   ├── knowledge/            # Knowledge adapters & manager
│   ├── runtime/              # Execution backends (in-process, docker, agent-os)
│   ├── channels/             # Communication channel adapters
│   ├── notifications/        # Notification channel implementations
│   ├── handlers/             # Telegram command handlers
│   ├── jobs/                 # Cron job registry
│   ├── tools/                # Vault file I/O tools
│   ├── migrations/           # SQL schema files (001-013)
│   ├── auth/                 # better-auth configuration
│   ├── config/               # Environment variable parsing
│   └── types/                # Shared TypeScript interfaces
├── web/                      # Frontend React application
│   ├── src/
│   │   ├── pages/            # Route pages (Chat, Agents, Connections, etc.)
│   │   ├── components/       # UI components (chat, admin, layout)
│   │   └── lib/              # API client, WebSocket, auth, runtime adapter
│   └── vite.config.ts        # Dev server with backend proxy
├── vault/                    # Knowledge base (Obsidian vault)
├── tasks/                    # Development task history
├── Dockerfile                # Multi-stage production build
├── docker-compose.yml        # Development environment
├── docker-compose.prod.yml   # Production deployment
└── flake.nix                 # Nix reproducible builds
```

## Evolution

Tela evolved through 8 phases:

| Phase | Focus | Tasks |
|-------|-------|-------|
| **1 — MVP** | Vault access, Telegram bot, agent core, scheduled jobs | 001–010 |
| **2 — Integrations** | Google Calendar/Gmail, meeting prep, knowledge ingestion | 011–020 |
| **3 — Engineering Intelligence** | ShipLens, Jira, GitHub, engineering alerts | 021–028 |
| **4 — Advanced Autonomy** | Vector store, pattern learning, proactive suggestions | 029–035 |
| **5 — Platform** | Web UI, API, agent config, connections, schedules | 036–046 |
| **6 — Enterprise** | Auth, RBAC, MCP governance, policies, audit, onboarding | 047–058 |
| **7 — Agent Runtime** | Streaming, compaction, deferred tools, circuit breakers | 060–069 |
| **8 — Orchestration & Isolation** | Runtime abstraction, Docker isolation, agent memory | 070–071 |
