# CLAUDE.md — Tela

## What is Tela?

Tela is an AI operating system for companies. It connects AI agents to tools, knowledge, and workflows — so every role in the company has an intelligent layer operating alongside them. The name means "screen" in Portuguese: the layer you interact through.

It is NOT a chatbot. It is NOT a dashboard. It is a governed, multi-agent platform where organizations connect their tools (OAuth), their knowledge (any source), and create AI agents scoped to roles, teams, and individuals — all with enterprise-grade access control and audit trails.

Built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents/claude-agent-sdk) + [Model Context Protocol](https://modelcontextprotocol.io/).

## RBAC is the core principle

**Everything must be scoped.** This is the most important architectural constraint in Tela.

- Agents, connections, knowledge sources, schedules, and any resources agents create must be scoped to the user/team/role that created them unless explicitly marked as public or shared.
- The permission model is **default deny** — access is denied unless an explicit policy grants it.
- When multiple policies apply (user + role + team), the **most permissive wins**, except when any policy explicitly sets `access_level = 'none'` (deny override).
- Admins bypass access checks, but their actions are still audited.

### How scoping works

| Resource | Scoped by | Notes |
|---|---|---|
| MCP connections | `token_strategy` (company/team/user) + `mcp_policies` | 3-tier credential resolution: user token > team token > company token |
| Knowledge sources | `knowledge_policies` (principal: user/role/team) | Read or write access per policy |
| Agents | `agent_policies` (can_use, can_configure) | Agent's effective MCP servers = agent config ∩ user's permitted servers |
| Schedules | `created_by_agent_id` | Should be scoped to the creating user |
| Tool calls | MCP Gateway (policy check > classification > rate limit > audit) | Every call filtered and logged |

### When building new features

- Always check `RbacService.canAccess*()` before serving protected resources.
- New resources must have an ownership model (who created it, who can see it).
- If a user creates something through an agent (a schedule, a workspace, a file), that resource belongs to that user — not to the agent, not to everyone.
- Public/shared resources must be an explicit opt-in, never the default.
- All access decisions must be logged to `audit_log`.

## Tech stack

- **Backend**: Node.js 22, TypeScript, Hono (HTTP/WS), better-sqlite3 (SQLite WAL)
- **Agent**: Claude Agent SDK, MCP SDK
- **Frontend**: React 19, Vite, Tailwind CSS v4, shadcn/ui, @assistant-ui/react, TanStack Query, React Router v7
- **Vector search**: ChromaDB + all-MiniLM-L6-v2 (ONNX)
- **Auth**: better-auth (session-based) + API keys
- **Containers**: Docker, Nix flake for reproducible builds

## Project structure

```
src/
  index.ts                  — Entry point, initializes all services
  api/
    server.ts               — Hono app, middleware, route registration
    middleware.ts            — Auth: session > API key > legacy token > dev mode
    ws.ts                   — WebSocket upgrade for streaming
    routes/                 — 25+ REST endpoints
  orchestrator/
    index.ts                — Routes messages to agents, manages execution
  agent/
    service.ts              — Agent execution engine (Claude Agent SDK)
    mcp-gateway.ts          — Authorization pipeline for every tool call
    vector-store.ts         — ChromaDB integration
    memory.ts               — Agent memory (facts, preferences, patterns)
    insforge-mcp-bridge.ts  — Container-exec MCP bridge
  runtime/
    index.ts                — Pluggable backends: in-process, docker, agent-os, devcontainer, remote
  knowledge/
    manager.ts              — Adapter registry, cross-source search
    adapters/               — Obsidian, filesystem
    chunker.ts              — Markdown heading-aware chunking
  channels/
    gateway.ts              — Multi-platform messaging (Telegram, Slack, GitHub, Jira)
  notifications/
    manager.ts              — Notification dispatch (Telegram, Slack, email, webhook, in-app)
  jobs/
    registry.ts             — Cron scheduler (node-cron, timezone-aware)
  core/
    database.ts             — SQLite + auto-migrations (18 migrations)
    rbac.ts                 — Role/team/user permission resolution
    encryption.ts           — AES-256-GCM for OAuth tokens
  tools/                    — Vault tools, schedule tools, devcontainer tools
  a2a/                      — Agent-to-Agent protocol (discovery, task management)
  migrations/               — SQL schema files (001-018)

web/src/
  App.tsx                   — Hash router, session checks, role-based access
  pages/                    — Chat, Agents, Connections, Knowledge, Schedules, Admin, etc.
  components/               — UI primitives + chat components
  lib/
    api.ts                  — REST client + TanStack Query hooks
    auth.ts                 — Session management
```

## Key architecture patterns

- **MCP Governance Gateway**: every tool call goes through policy check > tool filtering > data classification > rate limiting > credential injection > audit logging.
- **Plugin interfaces**: `KnowledgeAdapter`, `ChannelAdapter`, `RuntimeBackend`, `NotificationChannel` — extend by implementing the interface and registering.
- **Streaming-first**: `chatStream()` yields `AgentStreamEvent` for real-time UI. WebSocket for persistent connections.
- **3-tier credential resolution**: user token > team token > company token. Configured via `token_strategy` on connections.
- **Data classification hierarchy**: public < internal < confidential < restricted < top-secret. Per-tool classifications checked against user's max clearance.

## Development

```bash
# Backend
npm run dev          # tsx watch on port 3000

# Frontend (separate terminal)
cd web && npm run dev   # Vite on port 5173, proxies to :3000

# Tests
npm test
```

## Conventions

- Database migrations go in `src/migrations/` as numbered SQL files. They run automatically on startup.
- New API routes go in `src/api/routes/`, exported as a function that receives dependencies, registered in `server.ts`.
- New MCP tools are added in `AgentService.buildMcpServer()` using `tool()` from Claude Agent SDK.
- Environment variables are parsed in `src/config/env.ts`.
- Frontend uses hash-based routing (`#/path`). New pages go in `web/src/pages/`.
