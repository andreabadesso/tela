# Frontend & UI

Tela's frontend is a React single-page application providing a chat interface, admin panels, and configuration management.

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| React 19 | UI framework |
| Vite | Build tool + dev server |
| Tailwind CSS v4 | Utility-first styling |
| Shadcn/ui | Component library (Radix UI primitives) |
| assistant-ui | Headless chat components |
| TanStack Query v5 | Server state management |
| React Router v7 | Client-side routing |
| Lucide React | Icon library |
| remark-gfm | GitHub-flavored Markdown |

## Application Structure

```
web/src/
├── main.tsx                    # Entry point, mounts React app
├── App.tsx                     # Route definitions
├── pages/                      # Route-level components
│   ├── Chat.tsx                # Main chat interface
│   ├── Agents.tsx              # Agent list
│   ├── AgentEdit.tsx           # Agent configuration form
│   ├── Connections.tsx         # Connection management grid
│   ├── MyConnections.tsx       # User's delegated connections
│   ├── Knowledge.tsx           # Knowledge source list
│   ├── KnowledgeAdd.tsx        # Add knowledge source
│   ├── KnowledgeDetail.tsx     # Source details + sync status
│   ├── Schedules.tsx           # Schedule management
│   ├── Channels.tsx            # Notification channels
│   ├── AuditLog.tsx            # Audit trail viewer
│   ├── Settings.tsx            # System configuration
│   ├── Login.tsx               # Authentication
│   ├── Setup.tsx               # First-run wizard
│   ├── Onboarding.tsx          # Employee onboarding
│   └── admin/                  # Admin-only pages
│       ├── Users.tsx           # User management
│       ├── Roles.tsx           # Role definitions
│       └── Policies.tsx        # Access policy editor
├── components/
│   ├── chat/                   # Chat UI components
│   │   ├── MessageList.tsx     # Message rendering
│   │   ├── MessageInput.tsx    # Input with agent selector
│   │   ├── ToolCallCard.tsx    # Tool execution display
│   │   └── ThinkingIndicator.tsx
│   ├── assistant-ui/           # assistant-ui integration
│   │   ├── Thread.tsx          # Thread wrapper
│   │   ├── Markdown.tsx        # Markdown renderer
│   │   └── ToolFallback.tsx    # Tool call fallback display
│   ├── ui/                     # Shadcn primitives
│   │   ├── button.tsx
│   │   ├── card.tsx
│   │   ├── dialog.tsx
│   │   ├── tabs.tsx
│   │   └── ...
│   └── layout/
│       └── Layout.tsx          # Navigation, sidebar
└── lib/
    ├── api.ts                  # HTTP client (fetch wrapper + auth)
    ├── ws.ts                   # WebSocket client
    ├── auth.ts                 # Session management
    ├── tela-runtime.ts         # assistant-ui runtime adapter
    └── utils.ts                # Utility functions
```

## Pages

### Chat

The primary interface. Features:
- **Agent selector** — Pick which agent to talk to (or let orchestrator decide)
- **Thread management** — Create, switch, rename, delete conversations
- **Real-time streaming** — Per-token streaming via WebSocket
- **Tool execution display** — Shows tool calls with expandable input/output
- **Thinking indicator** — Visual feedback during model processing
- **Markdown rendering** — Full GFM support with syntax highlighting

**Runtime integration**: Uses `@assistant-ui/react` with a custom runtime adapter (`tela-runtime.ts`) that connects to Tela's WebSocket API. The adapter handles:
- Message serialization/deserialization
- Streaming token assembly
- Tool call lifecycle events
- Error handling and reconnection

### Agents

CRUD management for agents:
- **List view** — Cards showing agent name, model, default badge
- **Edit form** — Name, slug, model selector, system prompt editor, MCP server multi-select, knowledge source multi-select, token limit
- **Templates** — Quick-start templates (CTO, CEO, CFO, Support, Blank)
- **Preview** — System prompt preview with variable interpolation

### Connections

Integration management:
- **Grid layout** — Each service as a card with icon, name, status indicator
- **Supported types** — Jira, GitHub, Google, Slack, Notion, ShipLens, Custom MCP
- **OAuth flow** — "Connect" button starts OAuth, callback updates status
- **Test** — Verify connection is working
- **Token strategy** — Toggle between company (shared) and delegated (per-user)

### My Connections

User's personal delegated connections:
- Shows which services require personal authentication
- Status per service (connected / not connected)
- OAuth flow for connecting personal accounts
- Test and disconnect options

### Knowledge

Knowledge source management:
- **List** — Sources with type, document count, sync status, last synced
- **Add** — Configure new source (type, path/URL, sync options)
- **Detail** — Document list, sync history, manual sync trigger
- **Search preview** — Test semantic search against this source

### Schedules

Visual cron job management:
- **List** — Schedules with name, cron expression (human-readable), agent, status
- **Create/Edit** — Name, cron builder (or raw expression), prompt editor, agent selector, channel selector
- **Templates** — 12 pre-built schedule templates
- **Run Now** — Immediate execution button
- **History** — Per-schedule execution log

### Channels

Notification channel configuration:
- **List** — Channels with type, name, status
- **Add** — Type selector, config form (varies by type)
- **Test** — Send test notification
- **Enable/Disable** — Toggle per channel

### Audit Log

Filterable event viewer:
- **Filters** — By user, agent, connection, action type, time range, access decision
- **Table** — Timestamp, user, agent, action, tool, decision (badge: allowed/denied/rate_limited)
- **Detail expand** — Full input/output for each event
- **Export** — CSV download
- **Permission** — Admin sees all, users see only their own

### Settings

System configuration:
- **Company** — Name, timezone, default model
- **Notification preferences** — Default channels
- **API tokens** — Create/revoke personal API keys
- **Cost view** — Personal usage stats
- **Encryption** — Key rotation (admin only)

### Admin Pages

#### Users
- User list with email, name, roles, teams, last active
- Edit role/team assignments
- Deactivate/reactivate
- Force sign-out

#### Roles
- Role list with description and member count
- View members per role

#### Policies
- **Tabbed editor** — MCP, Knowledge, Agent policy tabs
- **Principal selector** — Role / Team / User
- **Resource selector** — Connection / Source / Agent
- **Access level** — read / write / none
- **Tool filtering** — Allowed/denied tool lists (MCP only)
- **Rate limits** — Per hour/day (MCP only)
- **Access Matrix** — Visual grid (roles × connections), color-coded
- **Tool Classification** — Per-connection tool sensitivity levels
- **Bulk actions** — Apply templates across roles

### Setup Wizard

First-run experience (when `setup_completed` is false):

```
Welcome → Admin Account → Company Info → Connect Tools →
Create Teams → Invite Users → Set Policies → Done
```

### Onboarding

Employee first-login experience (when `users.onboarded` is false):

```
Role Overview → Connect Personal Accounts → Quick Tour → Done
```

## API Client

`lib/api.ts` provides a typed HTTP client:

- Wraps `fetch` with authentication headers
- Base URL resolution (dev proxy or production)
- Error handling with typed error responses
- Used by TanStack Query hooks for server state

## WebSocket Client

`lib/ws.ts` manages the real-time connection:

- Auto-connect on chat page mount
- Reconnect with exponential backoff
- Message type parsing (token, tool_start, tool_result, done, error)
- Connection state exposed to UI (connecting, connected, disconnected)

## Development

```bash
cd web
npm install
npm run dev    # Vite dev server on :5173, proxies API to :3000
```

Vite config proxies `/api/*` and `/ws/*` to the backend during development.

## Production Build

```bash
cd web
npm run build   # Outputs to web/dist/
```

The backend serves the built SPA from `web/dist/` as static files via Hono's `serveStatic`.
