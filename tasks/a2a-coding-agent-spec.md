# Tela: A2A Protocol + Coding Agent + InsForge Integration Spec

## Context

Tela is an AI operating system for companies — multi-agent orchestration powered by Claude, with MCP governance, sandboxed runtimes, bidirectional channels (Slack, Telegram), and knowledge adapters.

**Goal**: Make Tela agents callable from anywhere (A2A protocol), and enable a **coding agent** that can build complete internal tools — backend + frontend — from a Slack message.

**Key insight**: InsForge (open-source BaaS for AI agents) provides database, auth, storage, edge functions, and deployment out of the box via MCP. This eliminates the need to build most backend infrastructure from scratch inside containers.

---

## Architecture Overview

```
External Agents / Slack / Web UI
          │
          ▼
┌─────────────────────────┐
│   A2A Protocol Server    │  ← NEW: Agent discovery + task lifecycle
│   (JSON-RPC 2.0 / SSE)  │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│      Orchestrator        │  ← EXISTING: routes to agents
└────────────┬────────────┘
             │
     ┌───────┴────────┐
     ▼                ▼
┌──────────┐   ┌──────────────┐
│ Standard │   │ Coding Agent │
│ Agents   │   │              │
│ (chat,   │   │ DevContainer │ ← NEW: persistent sandbox
│  cron)   │   │ Runtime      │    with full dev tooling
└──────────┘   └──────┬───────┘
                      │
              ┌───────┴────────┐
              ▼                ▼
       ┌────────────┐  ┌────────────┐
       │  InsForge   │  │ Container  │
       │  (BaaS)     │  │ Filesystem │
       │             │  │ Terminal   │
       │ - Database  │  │ Ports      │
       │ - Auth      │  │ Git        │
       │ - Storage   │  └────────────┘
       │ - Functions │
       │ - Deploy    │
       └────────────┘
```

---

## Part 1: A2A Protocol Server

### What

Expose Tela agents as A2A-compatible services so any external agent can discover and call them.

### Route Structure

```
GET  /.well-known/agent.json          → Agent Card (public, no auth)
POST /a2a                             → JSON-RPC 2.0 endpoint (API key auth)
```

### JSON-RPC Methods

| Method | Maps To | Notes |
|--------|---------|-------|
| `message/send` | `orchestrator.assign()` or `.chat()` | Creates task, returns result or task ID |
| `message/stream` | SSE response from `AgentExecutionHandle.stream` | Long-lived SSE connection |
| `tasks/get` | `db.getAgentRun(id)` + `db.getA2ATask(id)` | Poll task status |
| `tasks/list` | `db.getAgentRuns()` filtered by context | Paginated list |
| `tasks/cancel` | `runtime.cancel(runId)` | Cancel running task |
| `tasks/pushNotificationConfig/set` | Insert into `a2a_push_configs` | Register webhook |
| `tasks/pushNotificationConfig/get` | Query `a2a_push_configs` | Read webhook config |
| `tasks/pushNotificationConfig/list` | Query `a2a_push_configs` | List webhooks |
| `tasks/pushNotificationConfig/delete` | Delete from `a2a_push_configs` | Remove webhook |
| `agent/authenticatedExtendedCard` | Generate extended card with per-agent details | Auth required |

### Agent Card Generation

Auto-generated from `agents` table. Each enabled agent becomes a "skill":

```json
{
  "name": "Tela",
  "description": "AI operating system — multi-agent platform",
  "url": "https://tela.example.com/a2a",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  },
  "authentication": {
    "schemes": ["apiKey"]
  },
  "skills": [
    {
      "id": "coding-agent",
      "name": "Coding Agent",
      "description": "Builds complete web applications...",
      "tags": ["coding", "fullstack", "deployment"]
    }
  ]
}
```

### Task Lifecycle Mapping

```
A2A Status        →  agent_runs.status
─────────────────────────────────────
submitted         →  pending
working           →  running
completed         →  completed
failed            →  failed / timeout
canceled          →  cancelled
input-required    →  (future: agent paused, waiting for user input)
```

### SSE Streaming

Bridge `AsyncIterable<AgentStreamEvent>` to A2A SSE format:

```
AgentStreamEvent { type: 'text', data }    → SSE: {"jsonrpc":"2.0","method":"tasks/status","params":{"id":"...","status":{"state":"working","message":{...}}}}
AgentStreamEvent { type: 'tool_call' }     → SSE: tasks/status with tool call info
handle.result resolves                     → SSE: tasks/status with state "completed" + artifacts
```

### Push Notifications

On task status transitions, check `a2a_push_configs` for matching task, POST JSON-RPC notification to registered URL. Retry 3x with exponential backoff.

### Auth

Reuse existing `user_api_keys` table. A2A clients authenticate with `Authorization: Bearer <api-key>`. Resolved to a user via existing `resolveUserFromApiKey()`, which feeds into MCP Gateway RBAC.

### New Files

```
src/a2a/
  types.ts              — A2A protocol types (AgentCard, Task, Message, Artifact, etc.)
  agent-card.ts         — Generate agent card from DB
  task-manager.ts       — Task lifecycle, maps A2A ops to orchestrator/runtime
  sse-bridge.ts         — AsyncIterable<AgentStreamEvent> → SSE
  push-notifier.ts      — Webhook delivery with retries
  index.ts              — Factory: createA2AServer(deps) → Hono routes

src/api/routes/a2a.ts   — Mount point for JSON-RPC handler + well-known endpoint
```

### New DB Tables

```sql
-- Migration: 017_a2a.sql

-- Supplements agent_runs with A2A-specific metadata
CREATE TABLE a2a_tasks (
  id TEXT PRIMARY KEY,                         -- same as agent_runs.id
  context_id TEXT,                             -- groups related tasks
  skill_id TEXT,                               -- target agent/skill
  messages TEXT NOT NULL DEFAULT '[]',         -- JSON: A2A message history
  artifacts TEXT DEFAULT '[]',                 -- JSON: produced artifacts
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (id) REFERENCES agent_runs(id)
);

-- Push notification webhook configs
CREATE TABLE a2a_push_configs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  url TEXT NOT NULL,
  headers TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES a2a_tasks(id)
);
```

### Changes to Existing Files

- **`src/api/server.ts`**: Mount A2A routes. `/.well-known/agent.json` must be public (before auth middleware).
- **`src/config/env.ts`**: Add `A2A_ENABLED` (default true), `A2A_BASE_URL`.

---

## Part 2: InsForge as the Backend Infrastructure Layer

### What

Instead of building custom database, auth, storage, and function runtime inside containers, we use InsForge — a BaaS designed for AI agents — as a managed backend that the coding agent operates via MCP tools.

### Why InsForge

| Capability | Without InsForge | With InsForge |
|-----------|-----------------|--------------|
| Database | Agent manually sets up PostgreSQL in container | Agent calls `run-raw-sql`, `get-table-schema` via MCP |
| Auth | Agent builds auth from scratch | Agent uses InsForge auth (email, OAuth, JWT) |
| Storage | Agent configures S3/minio | Agent calls `create-bucket`, uploads via SDK |
| Functions | Agent writes + deploys server code | Agent creates edge functions via MCP (Deno Workers) |
| Deployment | Agent needs to manage containers | Agent deploys via InsForge (Vercel provider) |
| Frontend SDK | Agent writes raw fetch calls | Agent uses `@insforge/sdk` in generated code |

### Integration Model

InsForge runs as a **separate service** (Docker Compose: postgres, postgrest, insforge, deno, vector). Tela connects to it via:

1. **MCP Connection**: Register InsForge's MCP server (`@insforge/mcp`) as an MCP connection in Tela. The MCP Gateway governs access (RBAC, audit logging, rate limiting apply automatically).

2. **Per-workspace InsForge projects**: Each coding workspace gets its own InsForge project (isolated database, storage, auth). The workspace manager provisions this on creation.

3. **Agent tools**: The coding agent gets InsForge MCP tools through the normal MCP Gateway pipeline. No special integration needed — it's just another MCP server.

### InsForge Deployment

Add InsForge services to Tela's Docker Compose or run separately:

```yaml
# docker-compose.insforge.yml (companion to Tela)
services:
  insforge-postgres:
    image: postgres:15
    volumes:
      - insforge-pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_PASSWORD: ${INSFORGE_DB_PASSWORD}

  insforge-postgrest:
    image: postgrest/postgrest:v12.0.2
    depends_on: [insforge-postgres]

  insforge:
    image: ghcr.io/insforge/insforge:latest
    ports:
      - "7130:7130"
    depends_on: [insforge-postgres, insforge-postgrest]

  insforge-functions:
    image: ghcr.io/insforge/insforge-functions:latest
    ports:
      - "7133:7133"
    depends_on: [insforge]
```

### What the Agent Gets

When the coding agent is asked to "build me a CRM", it can:

1. **Create DB schema** via InsForge MCP: `run-raw-sql` to create tables (contacts, deals, activities)
2. **Set up auth** via InsForge MCP: configure email auth, create roles
3. **Create storage buckets** for file uploads
4. **Write edge functions** for custom business logic (webhooks, automation)
5. **Scaffold a React frontend** in the DevContainer that uses `@insforge/sdk`
6. **Deploy the frontend** via InsForge's deployment feature
7. Return the URL to the user

---

## Part 3: DevContainer Runtime

### What

A persistent, long-lived container runtime for building frontend code, running dev servers, and executing build pipelines. Complements InsForge (which handles backend infrastructure).

### Why Still Needed

InsForge handles backend (DB, auth, storage, functions), but the agent still needs a sandbox to:
- Scaffold and build frontend projects (React, Vue, Next.js, etc.)
- Run `npm install`, build tools, test runners
- Run dev servers to preview the app
- Execute git operations
- Write arbitrary code beyond edge functions

### Container Image: `tela-devcontainer`

Extends the existing Nix-built image with rich dev tooling:

```nix
# In flake.nix
devContainerImage = pkgs.dockerTools.buildLayeredImage {
  name = "tela-devcontainer";
  tag = "latest";
  contents = [
    pkgs.nodejs_22
    pkgs.python312
    pkgs.coreutils pkgs.findutils pkgs.gnugrep pkgs.gnused
    pkgs.cacert pkgs.curl pkgs.wget
    pkgs.git
    pkgs.jq pkgs.ripgrep pkgs.tree
    pkgs.bashInteractive pkgs.gnumake
    pkgs.openssh
    # Node tooling
    pkgs.nodePackages.npm
    pkgs.nodePackages.pnpm
  ];
};
```

### Workspace Persistence

Each coding task gets a **named workspace** backed by a Docker volume:

```
Docker Volume: tela-workspace-{workspaceId}
  → Mounted at /workspace inside the container
  → Survives container restarts
  → Explicit cleanup via workspace management API
```

### Port Forwarding

The container pre-allocates a port range (e.g., 3000-3005 inside → dynamic high ports on host). A lightweight TCP proxy manages the mapping:

```
Container :3000 (backend)  → Host :9042 → accessible at http://localhost:9042
Container :5173 (frontend) → Host :9043 → accessible at http://localhost:9043
```

Port allocation is controlled by agent permissions:
```json
{
  "permissions": {
    "runtime": "devcontainer",
    "allowed_ports": [3000, 3001, 5173, 8080],
    "max_background_processes": 5
  }
}
```

### Enhanced Sandbox Interface

```typescript
interface DevContainerSandbox extends ToolSandbox {
  // Inherited
  runCommand(command: string): Promise<ExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;

  // Filesystem
  mkdir(path: string, recursive?: boolean): Promise<void>;
  rm(path: string, recursive?: boolean): Promise<void>;
  ls(path: string): Promise<FileEntry[]>;
  glob(pattern: string, cwd?: string): Promise<string[]>;

  // Process management
  exec(command: string, opts?: { cwd?: string; env?: Record<string,string>; timeout?: number }): Promise<ExecResult>;
  execBackground(command: string, opts?: { cwd?: string }): Promise<{ pid: string }>;
  killProcess(pid: string): Promise<void>;
  listProcesses(): Promise<ProcessInfo[]>;

  // Port management
  exposePort(containerPort: number): Promise<{ hostPort: number; url: string }>;
  listPorts(): Promise<PortMapping[]>;

  // Workspace
  workspaceInfo(): Promise<{ id: string; path: string }>;
}
```

### Workspace Lifecycle

```
create  → Docker volume created, container started, workspace initialized
pause   → Container stopped, volume retained
resume  → Container restarted with same volume
destroy → Container removed, volume deleted
```

### Multi-Service Within Single Container

No Docker-in-Docker. The agent runs multiple processes as background jobs:

```
Agent calls: execBackground("npm run dev")      → frontend on :5173
Agent calls: execBackground("node server.js")   → backend on :3000
Agent calls: exposePort(5173)                    → returns http://localhost:9043
Agent calls: exposePort(3000)                    → returns http://localhost:9042
```

### Security

- No privileged mode
- No host filesystem mounts (only named volume)
- Bridge network — only `host.docker.internal` for MCP proxy callback
- Port exposure validated against allowlist
- Resource limits: 2GB RAM, 2 CPU, 10GB disk
- 30-minute default timeout per run (workspace persists beyond timeout)

### New Files

```
src/runtime/
  devcontainer.ts           — DevContainerRuntime implements AgentRuntime
  devcontainer-sandbox.ts   — Enhanced ToolSandbox for dev operations
  workspace-manager.ts      — Workspace CRUD + Docker volume management
  port-proxy.ts             — TCP proxy for dynamic port forwarding
```

### New DB Table

```sql
-- Migration: 018_workspaces.sql

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  container_id TEXT,
  volume_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',  -- created, running, paused, destroyed
  port_mappings TEXT DEFAULT '[]',
  insforge_project_id TEXT,                -- linked InsForge project (if any)
  disk_usage_mb INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_active_at TEXT
);
```

### Coding Agent MCP Tools

Exposed to the coding agent via a dedicated MCP server built from `DevContainerSandbox`:

```
write_file(path, content)        — Write/create file in workspace
read_file(path)                  — Read file from workspace
list_directory(path)             — List directory contents
create_directory(path)           — mkdir -p
delete_path(path)                — rm -rf (within workspace only)
find_files(pattern)              — Glob search

run_command(command, cwd?)       — Execute shell command (blocking)
start_process(command, cwd?)     — Start background process
stop_process(pid)                — Kill background process
list_processes()                 — List running processes

expose_port(port)                — Make container port accessible, returns URL
list_ports()                     — List exposed ports

git_init()                       — Initialize git repo
git_commit(message)              — Stage all + commit
git_status()                     — Show status
```

---

## Part 4: The Full Flow

### Slack → Coding Agent → Full App

```
1. User in Slack: "@tela build me a CRM with contacts, deals, and activity tracking"

2. SlackAdapter receives @mention → ChannelGateway.handleInbound()

3. Orchestrator resolves to coding-agent (intent routing or explicit mention)

4. Orchestrator detects runtime=devcontainer → switches to assign() mode
   Returns immediately: "On it! Building your CRM. I'll update you in this thread."

5. DevContainerRuntime creates/resumes workspace:
   - Docker volume: tela-workspace-crm-abc123
   - Container: tela-devcontainer with volume mounted at /workspace
   - InsForge project provisioned (if not exists)

6. Coding agent executes with full tool access:

   Turn 1: Set up backend via InsForge MCP
   - run-raw-sql: CREATE TABLE contacts (id, name, email, company, ...)
   - run-raw-sql: CREATE TABLE deals (id, contact_id, value, stage, ...)
   - run-raw-sql: CREATE TABLE activities (id, deal_id, type, notes, ...)
   - Configure auth (email + password)
   - Create storage bucket for attachments

   Turn 2-5: Build frontend in DevContainer
   - run_command("npx create-vite crm-app --template react-ts")
   - run_command("cd crm-app && npm install @insforge/sdk @tanstack/react-query ...")
   - write_file("crm-app/src/lib/insforge.ts", client setup code)
   - write_file("crm-app/src/pages/Contacts.tsx", ...)
   - write_file("crm-app/src/pages/Deals.tsx", ...)
   - ... (multiple files)

   Turn 6: Build and run
   - run_command("cd crm-app && npm run build")
   - start_process("cd crm-app && npm run preview -- --port 5173")
   - expose_port(5173) → returns http://localhost:9043

   Turn 7: Deploy (optional)
   - create-deployment via InsForge MCP → returns production URL

7. Agent completes. Result flows back through:
   - DevContainerRuntime resolves result
   - ChannelGateway.notifyTarget("slack:#channel:thread_ts")
   - Slack thread gets: "Your CRM is ready!
     - Preview: http://localhost:9043
     - Production: https://crm-abc123.insforge.dev
     - Database: 3 tables (contacts, deals, activities)
     - Auth: email/password enabled"

8. If called via A2A instead of Slack:
   - A2A task status transitions: submitted → working → completed
   - SSE streams progress in real-time
   - Push notification fires on completion (if configured)
   - Response includes artifacts (URLs, file list, schema)
```

### A2A → Coding Agent (External Agent Integration)

```
External agent discovers Tela via GET /.well-known/agent.json
  → Sees "coding-agent" skill
  → Sends JSON-RPC: message/send { skill: "coding-agent", message: "Build a REST API..." }
  → Gets back task ID
  → Polls tasks/get or subscribes via SSE
  → Gets result with URLs and artifacts
```

---

## Part 5: Implementation Order

### Phase 1: A2A Foundation
- `src/a2a/types.ts` — protocol types
- Migration `017_a2a.sql` — a2a_tasks, a2a_push_configs tables
- `src/a2a/agent-card.ts` — card generation from agents table
- `src/a2a/task-manager.ts` — task lifecycle mapping to orchestrator
- `src/api/routes/a2a.ts` — JSON-RPC handler (message/send, tasks/get, tasks/list, tasks/cancel)
- Mount in `src/api/server.ts`
- Test with curl

### Phase 2: A2A Streaming + Push
- `src/a2a/sse-bridge.ts` — SSE streaming adapter
- `src/a2a/push-notifier.ts` — webhook delivery
- Add message/stream, push config CRUD, extended card to JSON-RPC handler
- End-to-end test: external client → task → stream → result

### Phase 3: InsForge Integration
- Add InsForge to docker-compose (postgres, postgrest, insforge, functions)
- Register InsForge MCP server as a connection in Tela
- Configure MCP Gateway policies for InsForge tools
- Test: agent can create tables, functions, storage via MCP

### Phase 4: DevContainer Runtime
- Extend `flake.nix` with devcontainer image
- Migration `018_workspaces.sql`
- `src/runtime/workspace-manager.ts` — workspace CRUD
- `src/runtime/port-proxy.ts` — TCP port forwarding
- `src/runtime/devcontainer-sandbox.ts` — enhanced ToolSandbox
- `src/runtime/devcontainer.ts` — DevContainerRuntime
- Register in `src/runtime/index.ts`
- Coding agent MCP tools

### Phase 5: Coding Agent Profile
- Seed coding agent in DB (system prompt, permissions, runtime=devcontainer)
- System prompt with instructions for using InsForge + DevContainer tools
- Wire InsForge MCP tools + DevContainer tools into agent's tool set
- Update orchestrator: devcontainer runtime → auto assign mode + acknowledgment

### Phase 6: End-to-End Integration
- Slack → coding agent → InsForge + DevContainer → result back to Slack thread
- A2A → coding agent → same flow → result via A2A task
- Progress reporting during long builds
- Workspace management API + UI

### Phase 7: Polish
- Workspace cleanup cron (destroy inactive workspaces after configurable hours)
- Workspace UI in frontend (list, status, port links, logs)
- A2A conformance testing
- InsForge project cleanup on workspace destroy

---

## Key Design Decisions

1. **InsForge for backend, DevContainer for frontend**: Avoids reinventing BaaS. InsForge handles DB/auth/storage/functions natively. DevContainer handles filesystem/terminal/ports for building and previewing.

2. **InsForge as MCP connection (not embedded)**: Runs as separate service, connected via MCP Gateway. Gets full RBAC, audit logging, rate limiting for free. Can be swapped out.

3. **Single container, multiple processes**: No Docker-in-Docker. Background processes for dev servers inside one container. Simpler, more secure.

4. **JSON-RPC 2.0 first**: Simplest A2A binding. gRPC later if needed.

5. **SSE for A2A, WebSocket for Web UI**: A2A spec mandates SSE. Existing WebSocket kept for web frontend. Both bridge from the same `AgentStreamEvent` iterator.

6. **Workspace persistence**: Docker volumes survive container restarts. Explicit destroy required. Cleanup cron for abandoned workspaces.

7. **Port proxy over direct exposure**: TCP proxy layer validates ports against allowlist, can be torn down instantly.

8. **No `input-required` initially**: Complex to implement (requires pausing agent mid-execution). Tasks run to completion. Add later.

---

## Critical Files to Modify

| File | Change |
|------|--------|
| `src/api/server.ts` | Mount A2A routes, public well-known endpoint |
| `src/runtime/index.ts` | Register DevContainerRuntime |
| `src/types/runtime.ts` | Add DevContainerSandbox interface, 'devcontainer' runtime type |
| `src/orchestrator/index.ts` | Auto-assign mode for devcontainer runtime |
| `src/config/env.ts` | A2A_ENABLED, A2A_BASE_URL, INSFORGE_API_URL, INSFORGE_API_KEY |
| `flake.nix` | Add devcontainer image definition |

## New Files

```
src/a2a/types.ts
src/a2a/agent-card.ts
src/a2a/task-manager.ts
src/a2a/sse-bridge.ts
src/a2a/push-notifier.ts
src/a2a/index.ts
src/api/routes/a2a.ts
src/runtime/devcontainer.ts
src/runtime/devcontainer-sandbox.ts
src/runtime/workspace-manager.ts
src/runtime/port-proxy.ts
src/migrations/017_a2a.sql
src/migrations/018_workspaces.sql
docker-compose.insforge.yml
```
