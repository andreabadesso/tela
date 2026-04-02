# Deployment & Operations

## Development Setup

### Prerequisites
- Node.js 22+
- npm
- Docker (optional, for ChromaDB and isolated runtimes)

### Quick Start

```bash
# Backend
npm install
cp .env.example .env
# Edit .env with at minimum ANTHROPIC_API_KEY
npm run dev          # tsx watch, port 3000

# Frontend (separate terminal)
cd web
npm install
npm run dev          # Vite dev server, port 5173 (proxies to 3000)
```

### Dev Mode

When `API_TOKEN` is empty, auth is disabled — all requests are granted admin access with a synthetic user. This is intended for local development only.

## Docker Deployment

### Development (docker-compose.yml)

```bash
docker compose up --build
```

Services:
- **tela** — Backend + frontend on port 3000
- **chromadb** — Vector database on port 8000

### Production (docker-compose.prod.yml)

```bash
docker compose -f docker-compose.prod.yml up --build
```

Single container serves:
- Frontend SPA (static files)
- Backend API (REST + WebSocket)
- Telegram bot (if configured)
- Cron jobs
- ChromaDB runs as separate service

### Multi-Stage Dockerfile

```dockerfile
# Stage 1: Frontend build
FROM node:22-alpine AS frontend
# Build React app with Vite

# Stage 2: Backend build
FROM node:22-alpine AS backend
# Compile TypeScript

# Stage 3: Runtime
FROM node:22-slim AS runtime
# Minimal image with: git, ripgrep, openssh, curl
# Copy compiled backend + built frontend
```

### Volumes

| Volume | Purpose | Mount |
|--------|---------|-------|
| `vault-data` | Obsidian vault / knowledge base | `/app/vault` |
| `agent-db` | SQLite database | `/app/agent.db` |
| `chroma-data` | Vector store data | ChromaDB container |
| `transcripts` | Meeting transcripts | `/app/transcripts` |
| `ssh-keys` | Git SSH credentials | `/root/.ssh` (read-only) |

### Health Check

Docker health check configured:
```
GET http://localhost:3000/api/health
Interval: 30s
Timeout: 10s
Retries: 3
```

## Nix Flakes

For reproducible builds:

```bash
nix develop              # Enter dev shell with all dependencies
nix run .#build-worker   # Build agent worker Docker image
```

The flake provides:
- Dev shell with Node.js, npm, Docker CLI
- Agent worker image builder
- Reproducible dependency resolution

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | API server port |
| `VAULT_PATH` | `./vault` | Knowledge vault directory |
| `TZ` | `America/Sao_Paulo` | System timezone |
| `API_TOKEN` | _(empty = dev mode)_ | Auth token (empty disables auth) |
| `ENCRYPTION_KEY` | _(auto-generated)_ | 32-byte hex for credential encryption |

### Telegram (Optional)

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Grammy bot token |
| `TELEGRAM_CHAT_ID` | Authorized chat ID |

### Google Workspace (Optional)

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL |

### Engineering Tools (Optional)

| Variable | Description |
|----------|-------------|
| `JIRA_BASE_URL` | Jira instance URL |
| `JIRA_API_TOKEN` | Jira API token |
| `JIRA_USER_EMAIL` | Jira auth email |
| `GITHUB_TOKEN` | GitHub personal access token |
| `GITHUB_ORG` | GitHub organization |
| `GITHUB_REPOS` | Comma-separated repo list |
| `SHIPLENS_URL` | ShipLens MCP server URL |
| `SHIPLENS_API_KEY` | ShipLens API key |

### Vector Search (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROMA_URL` | `http://localhost:8000` | ChromaDB endpoint |

### Runtime (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_RUNTIME` | _(fallback chain)_ | Runtime: `in-process`, `agent-os`, `docker` |
| `AGENT_DOCKER_IMAGE` | `tela-agent-worker:latest` | Docker worker image name |

## Health Endpoint

`GET /api/health` returns:

```json
{
  "status": "healthy",
  "uptime": 86400,
  "version": "1.0.0",
  "services": {
    "database": "healthy",
    "chromadb": "healthy",
    "telegram": "healthy",
    "mcp_servers": {
      "shiplens": "healthy",
      "github": "degraded"
    }
  },
  "circuit_breakers": {
    "auto_compact": "closed",
    "chromadb": "closed",
    "shiplens": "closed"
  },
  "metrics": {
    "active_users": 12,
    "conversations_today": 45,
    "tool_calls_today": 230,
    "errors_today": 2
  }
}
```

Fast path: responds immediately even during startup (before all services are initialized).

## Monitoring

### Prometheus Metrics

`GET /api/metrics` exposes Prometheus-compatible metrics:

```
# Active users
tela_active_users 12

# Request rate
tela_requests_per_second 2.5

# Query latency histogram
tela_query_duration_seconds_bucket{le="0.1"} 45
tela_query_duration_seconds_bucket{le="1.0"} 120
tela_query_duration_seconds_bucket{le="10.0"} 150

# Tool calls by connection
tela_tool_calls_total{connection="github"} 89
tela_tool_calls_total{connection="jira"} 45

# Errors by type
tela_errors_total{type="api_timeout"} 2
tela_errors_total{type="mcp_failure"} 1

# Cost accumulator
tela_cost_cents_total 1234.56
```

### Audit Log

Comprehensive audit trail accessible from:
- **Web UI** — AuditLog page with filters and export
- **API** — `GET /api/audit` with query params
- **CSV export** — Downloadable from UI

### Cost Dashboard

Admin UI shows:
- Per-user cost breakdown
- Per-team aggregate costs
- Per-connection tool call counts
- Budget utilization (% of limit used)
- Trend over time

## Database Maintenance

### Backup

SQLite WAL mode allows hot backups:
```bash
sqlite3 agent.db ".backup backup.db"
```

### Migration Path to Postgres

Criteria for switching (task 056):
- Load test with 30 concurrent users
- If p99 query latency > 100ms → evaluate Postgres
- Migration tooling built into the codebase

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Backend dev server (tsx watch, port 3000) |
| `npm run build` | Compile TypeScript to dist/ |
| `npm run test` | Run Vitest |
| `npm run test:watch` | Vitest watch mode |
| `cd web && npm run dev` | Frontend dev server (Vite, port 5173) |
| `cd web && npm run build` | Build frontend to web/dist/ |

## Testing

### Framework
- **Vitest** for unit and integration tests

### Test Coverage
- Vault tools (read, write, edit, append, search, tasks)
- Git sync (pull, commit, batch, conflict handling)
- Job framework (registry, execution, failure handling, auto-disable)
- Integration: `/todo` flow with mocked Telegram/Claude/Git

### Running Tests

```bash
npm run test            # Run once
npm run test:watch      # Watch mode
```

## Security Checklist

Before deploying to production:

- [ ] Set `API_TOKEN` to a strong value (or configure better-auth with Google SSO)
- [ ] Set `ENCRYPTION_KEY` to a 32-byte hex string
- [ ] Restrict `TELEGRAM_CHAT_ID` to authorized chat
- [ ] Configure `allowed_email_domains` in settings
- [ ] Set up initial RBAC policies via setup wizard
- [ ] Review default role permissions
- [ ] Enable HTTPS (via reverse proxy)
- [ ] Set up backup schedule for `agent.db`
- [ ] Configure Prometheus scraping for `/api/metrics`
