# Tela

> The AI operating system for companies.

Tela connects AI agents to your tools, knowledge, and workflows — so every role in the company has an intelligent layer operating alongside them. Built for enterprise deployment with governed MCP access, role-based permissions, and per-user audit trails.

Built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents/claude-agent-sdk) + [Model Context Protocol](https://modelcontextprotocol.io/).

## What it does

- **Multi-agent orchestrator** — specialized agents per role (CTO, Finance, Sales, HR), with intent routing, council mode, and task delegation
- **Governed MCP access** — role-based permissions on every MCP tool call. A trainee can't see financial data — tools are filtered before the LLM runs
- **Web UI** — React + Shadcn + assistant-ui chat interface with real-time streaming, agent selector, and full admin panel
- **OAuth connection management** — one-click OAuth to Jira, GitHub, Google, Slack. Company-wide or per-user tokens
- **Pluggable knowledge sources** — Obsidian vault, filesystem, Notion, Confluence. Unified vector search (ChromaDB)
- **Visual scheduling** — DB-defined cron jobs with 12 templates (morning briefing, PR alerts, etc.)
- **Notification channels** — Telegram, Slack, email, webhook, web UI. Per-schedule targeting
- **Audit log** — every agent action logged with user identity, tool name, access decision
- **Budget controls** — per-user, per-agent cost tracking with hard stops and approval gates

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                              │
│  React + Shadcn/ui + assistant-ui                            │
│  Chat │ Agents │ Connections │ Schedules │ Knowledge │ Admin │
├─────────────────────────────────────────────────────────────┤
│                     API LAYER (Hono + WS)                    │
│                  Auth: better-auth + Google SSO               │
├─────────────────────────────────────────────────────────────┤
│                    ORCHESTRATOR                               │
│  Routes requests → selects agent → manages turns             │
│  Chat mode │ Batch mode │ Council mode                       │
├─────────────────────────────────────────────────────────────┤
│              MCP GOVERNANCE GATEWAY                           │
│  Per-user tool filtering │ Data classification │ Rate limits  │
│  Audit logging │ Credential injection │ Policy enforcement    │
├──────────────┬──────────────┬──────────────┬────────────────┤
│  Jira MCP    │  GitHub MCP  │  ShipLens    │  Custom MCP    │
├──────────────┴──────────────┴──────────────┴────────────────┤
│                   RBAC ENGINE                                │
│  Users │ Roles │ Teams │ Policies │ Budget │ Approvals       │
├─────────────────────────────────────────────────────────────┤
│                  KNOWLEDGE LAYER                              │
│  Obsidian │ Filesystem │ Notion │ Confluence │ ChromaDB       │
├─────────────────────────────────────────────────────────────┤
│                   PERSISTENCE                                │
│  SQLite (→ Postgres) │ Conversations │ Audit │ Policies      │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Development

```bash
# Backend (API + Telegram + cron)
npm install
cp .env.example .env   # fill in values
npm run dev             # tsx watch on port 3090

# Frontend (React dev server)
cd web && npm install && npm run dev   # Vite on port 5173, proxies to backend
```

### Docker (production)

```bash
docker compose -f docker-compose.prod.yml up --build
# Frontend + API on http://localhost:3000
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `VAULT_PATH` | No | Path to Obsidian vault (default: `./vault`) |
| `PORT` | No | API server port (default: 3000) |
| `API_TOKEN` | No | Bearer token for API auth (legacy, replaced by SSO in Phase 6) |
| `ENCRYPTION_KEY` | No | 32-byte hex key for OAuth token encryption |
| `TZ` | No | Timezone (default: `America/Sao_Paulo`) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot (optional, web-only mode without) |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID |
| `GIT_REMOTE_URL` | No | Git remote for vault sync |
| `GOOGLE_CLIENT_ID` | No | Google Calendar/Gmail OAuth |
| `GOOGLE_CLIENT_SECRET` | No | Google Calendar/Gmail OAuth |
| `GOOGLE_SSO_CLIENT_ID` | No | Google Workspace SSO (Phase 6) |
| `GOOGLE_SSO_CLIENT_SECRET` | No | Google Workspace SSO (Phase 6) |
| `SHIPLENS_URL` | No | ShipLens MCP server URL |
| `JIRA_BASE_URL` | No | Jira Cloud URL |
| `JIRA_API_TOKEN` | No | Jira API token |
| `GITHUB_TOKEN` | No | GitHub token |
| `GITHUB_ORG` | No | GitHub organization |
| `CHROMA_URL` | No | ChromaDB URL (default: `http://localhost:8000`) |

## Project Structure

```
src/
├── api/                  # Hono API server, routes, middleware, WebSocket
├── orchestrator/         # Multi-agent orchestrator, MCP tools
├── knowledge/            # Knowledge adapters (Obsidian, filesystem)
├── notifications/        # Pluggable channels (Telegram, Slack, email)
├── migrations/           # SQLite migration runner + SQL files
├── services/             # Core services (DB, git, encryption, agent, RBAC)
├── handlers/             # Telegram command handlers
├── jobs/                 # Cron job definitions
├── tools/                # Vault MCP tools
├── config/               # Environment config
└── types/                # TypeScript type definitions

web/                      # React frontend (Vite + Shadcn + assistant-ui)
├── src/pages/            # Chat, Agents, Connections, Schedules, Knowledge, etc.
├── src/components/       # Layout, UI components
└── src/lib/              # API client, WebSocket, assistant-ui runtime adapter
```

## Phases

| Phase | Name | Tasks | Status |
|-------|------|-------|--------|
| 1 | MVP | 001–010 | Done |
| 2 | Integrations | 011–020 | Done |
| 3 | Engineering Intelligence | 021–028 | Done |
| 4 | Advanced Autonomy | 029–035 | Done |
| 5 | Platform | 036–046 | Done |
| 6 | Enterprise | 047–058 | In Progress |

See [tasks/README.md](tasks/README.md) for full task specs and dependency graphs.

## License

Private — not published.
