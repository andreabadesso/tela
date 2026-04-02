# MCP Governance

The MCP governance system is Tela's core enterprise feature. It sits between agents and MCP servers, ensuring every tool call is authorized, rate-limited, audited, and credential-injected.

## Overview

When an agent runs for a user, the tools it can access are:

```
Accessible tools = Agent's configured servers
                 ∩ User's role-based permissions
                 ∩ Healthy connections
```

This intersection is computed by the MCP Gateway before every agent execution.

## MCP Gateway

The gateway (`src/services/mcp-gateway.ts`) wraps every MCP server with a governed proxy.

### Gateway Pipeline

For each tool call:

```
1. Tool Filtering     → Is this tool in the allowed list?
2. Access Level Check → Does the user have read/write access?
3. Data Classification→ Is the user cleared for this data sensitivity?
4. Rate Limiting      → Has the user exceeded their quota?
5. Credential Inject  → Inject the right token (user/team/company)
6. Execute            → Forward call to real MCP server
7. Audit Log          → Record identity, tool, decision, result
```

### Tool Filtering

MCP policies define per-principal (role, team, or user) which tools are allowed or denied:

- **Allowed tools list** — Whitelist of specific tools (empty = all allowed)
- **Denied tools list** — Blacklist that overrides allowed (takes precedence)
- **Access level** — `read`, `write`, or `none`
  - `read` — Can call read-only tools
  - `write` — Can call all tools
  - `none` — Complete deny for this connection

### Data Classification

Tools are classified by sensitivity:

| Level | Description | Example |
|-------|-------------|---------|
| `public` | No restrictions | `list_repos` |
| `internal` | Company employees only | `search_issues` |
| `confidential` | Role-restricted | `read_financials` |
| `restricted` | Explicit approval needed | `delete_user` |

Users have a max classification level from their policies. Tool calls that exceed the user's clearance are denied.

### Rate Limiting

Per `(user, connection)` pair:
- Configurable per hour and per day limits
- Tracked in memory, persisted periodically
- Returns `rate_limited` decision in audit log when exceeded

### Credential Injection

Three-tier credential resolution:

1. **User token** — From `user_connections` (delegated strategy)
2. **Team token** — Future: team-level shared credentials
3. **Company token** — From `connections` table (company strategy)

The `token_strategy` field on each connection determines which tier to use:
- `company` — All users share the organization's token
- `delegated` — Each user must connect their own account

### Bypass-Immune Checks

Certain operations are always blocked regardless of permissions:

- **Database deletion** — Cannot drop tables or delete databases
- **Auth modification** — Cannot modify authentication settings
- **Credential exfiltration** — Cannot read or export stored credentials

These checks cannot be bypassed by any policy, admin or otherwise.

## MCP Server Registry

The registry (`src/services/mcp-registry.ts`) manages live connections to MCP servers.

### Supported Transports

| Transport | Use Case | Example |
|-----------|----------|---------|
| SSE | Remote servers | ShipLens |
| Streamable HTTP | Modern MCP servers | Custom APIs |
| stdio | Local processes | CLI tools |

### Health Monitoring

- Ping every 5 minutes
- Auto-reconnect on recovery
- Mark unhealthy after consecutive failures
- Unhealthy servers excluded from agent tool lists
- Health state exposed via `/api/health` endpoint

### Auto-Discovery

On connection, the registry calls `tools/list` on each MCP server to discover available tools. This catalog is used for:
- Populating the policy admin UI
- Tool classification management
- Deferred tool loading

## Tool Execution Pipeline

Every tool invocation passes through a 7-step pipeline (task 063):

```
Step 1: Input Validation        (Zod schema)
Step 2: Permission Check        (deny rules → safety → bypass-immune → RBAC → rate limit)
Step 3: Pre-Hook Audit          (log attempt)
Step 4: Execute                 (forward to MCP server)
Step 5: Post-Hook Audit         (log result)
Step 6: Output Validation       (sanitize response)
Step 7: Return                  (to agent)
```

### Permission Check Order

The permission check in step 2 follows a strict order:

1. **Deny rules** — Any policy with `access_level: none` for this principal → immediate deny
2. **Safety check** — Bypass-immune rules (no DB deletion, no auth modification, no credential exfiltration)
3. **RBAC check** — Resolve effective permissions from all applicable policies
4. **Rate limit check** — Per-user, per-connection quota

### Invocation Classification

Each tool call is classified as:
- **Routine** — Standard read/write within normal parameters
- **Elevated** — Operations flagged for additional scrutiny (large data access, destructive operations)

### Large Result Handling

Results exceeding 25K tokens are truncated and persisted to disk. The agent receives a truncated version with a pointer to the full result.

## Policies Database Schema

### `mcp_policies`

| Column | Description |
|--------|-------------|
| `principal_type` | `role`, `team`, or `user` |
| `principal_id` | ID of the role, team, or user |
| `connection_id` | Which MCP connection this policy applies to |
| `access_level` | `read`, `write`, or `none` |
| `allowed_tools` | JSON array of tool names (empty = all) |
| `denied_tools` | JSON array of tool names (overrides allowed) |
| `max_data_classification` | Highest classification level allowed |
| `rate_limit_per_hour` | Max tool calls per hour |
| `rate_limit_per_day` | Max tool calls per day |

Unique constraint on `(principal_type, principal_id, connection_id)` prevents duplicate policies.

### `mcp_tool_classifications`

| Column | Description |
|--------|-------------|
| `connection_id` | Which MCP connection |
| `tool_name` | The specific tool |
| `classification` | `public`, `internal`, `confidential`, or `restricted` |

## Policy Admin UI

The admin interface (task 051) provides:

- **Tabbed policy editor** — MCP, Knowledge, and Agent policy tabs
- **Principal selector** — Pick role, team, or specific user
- **Connection selector** — Pick which MCP server
- **Access matrix** — Roles x Connections grid, color-coded by access level
- **Tool classification page** — Per connection, classify each discovered tool
- **Bulk actions** — Apply policy templates across roles

## Deferred Tool Loading

To reduce system prompt size (task 064):

### Always-Loaded Tools (Core Vault)
- `read_note`, `write_note`, `search_vault`, `list_notes`
- `tool_search` — Meta-tool for discovering deferred tools

### Deferred Tools
- Knowledge source tools
- External MCP server tools
- Loaded on-demand via `tool_search`

### Discovery

`tool_search` uses keyword scoring:
- Exact name match: 10 points
- Keyword in tool name: 5 points  
- Keyword in description: 2 points

Schema cached per session after first load. Expected savings: 40-60% reduction in system prompt tokens.
