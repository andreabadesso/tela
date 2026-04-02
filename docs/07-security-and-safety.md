# Security & Safety

Tela implements defense-in-depth security across multiple layers — from prompt injection prevention to enterprise hardening.

## Prompt Injection Defense (Task 067)

An 8-layer defense system protects against prompt injection attacks:

### Layer 1: Cognitive Priming
System prompt includes explicit warnings about embedded instructions in external content. Agents are instructed to ignore any instructions found in tool results, knowledge documents, or user-provided content that attempt to override their behavior.

### Layer 2: Structural Tagging
All content is tagged by origin so the model can distinguish trusted from untrusted:

| Tag | Source |
|-----|--------|
| `<user-input>` | Direct user messages |
| `<knowledge-result source="...">` | Knowledge search results |
| `<external-tool-result server="...">` | MCP tool responses |
| `<agent-result agent="...">` | Results from other agents |

### Layer 3: Compositional Limits
Large results (>25K tokens) are persisted to disk rather than injected into context. Agent receives a truncated summary with a file reference, reducing the attack surface of large external content.

### Layer 4: MCP Result Sanitization
Results from MCP servers are sanitized:
- Strip any XML/HTML-like tags that could be confused with system tags
- Escape content that resembles prompt instructions

### Layer 5: Agent Profiles
Agents have execution profiles that limit their capabilities:

| Profile | Capabilities |
|---------|-------------|
| `researcher` | Read-only tool access — cannot write, delete, or modify |
| `executor` | Full read-write access within policy bounds |

### Layer 6: Synthesis (Council Mode)
When multiple agents produce results in council mode, the coordinator synthesizes them — no raw passthrough. This prevents a compromised agent result from directly reaching the user.

### Layer 7: Detection & Logging
Suspicious patterns are detected and logged (but not blocked, to avoid false positives):
- "ignore previous instructions"
- "you are now"
- "override"
- "act as"

Legitimate content containing these phrases is not blocked — they're logged for review.

### Layer 8: Human-in-the-Loop
The `request_approval` tool allows agents to pause and ask for human approval before executing sensitive operations. Budget hard stops also create approval gates.

## Bypass-Immune Checks

Certain operations are always blocked, regardless of permissions, policies, or admin status:

| Check | Description |
|-------|-------------|
| **No DB deletion** | Cannot drop tables, truncate, or delete databases |
| **No auth modification** | Cannot modify authentication settings, create backdoor accounts |
| **No credential exfiltration** | Cannot read, export, or transmit stored credentials |

These are hardcoded in the tool execution pipeline and cannot be overridden by any policy.

## Tool Execution Pipeline (Task 063)

Every tool invocation passes through a standardized 7-step pipeline:

```
1. Input Validation     → Zod schema validation
2. Permission Check     → Deny rules → Safety → Bypass-immune → RBAC → Rate limit
3. Pre-Hook Audit       → Log the attempt (identity, tool, input)
4. Execute              → Forward to MCP server
5. Post-Hook Audit      → Log the result (output, duration, status)
6. Output Validation    → Sanitize response, strip injection attempts
7. Return               → Deliver result to agent
```

### Permission Check Hierarchy

```
Deny rules (any 'none' policy)
  ↓ pass
Safety check (bypass-immune rules)
  ↓ pass
RBAC check (effective permissions from roles/teams/user)
  ↓ pass
Rate limit check (per-user, per-connection quota)
  ↓ pass
Execute
```

A failure at any step short-circuits the pipeline and returns a denial.

## Enterprise Hardening (Task 056)

### Session Security
- Concurrent session limits per user
- Admin force sign-out capability
- Session activity tracking (last active timestamp)
- Auto-expire inactive sessions (7 days)

### Input Validation
- All API inputs validated with Zod schemas
- SQL injection prevention through parameterized queries
- XSS prevention in API responses

### HTTP Security Headers
Helmet-style security headers on all responses:
- Content-Security-Policy
- X-Content-Type-Options
- X-Frame-Options
- Strict-Transport-Security

### Rate Limiting
- Brute-force protection on login endpoints
- Per-user, per-connection tool call limits (configurable via policies)

### CSRF Protection
- CSRF tokens on state-changing requests

### Security Audit
- SQL injection audit across all queries
- XSS review of all user-facing output

## Circuit Breakers & Error Resilience (Task 065)

### Subsystem Classification

| Subsystem | Failure Mode | Rationale |
|-----------|-------------|-----------|
| **API calls to Claude** | Retry with fallback | Core functionality, must recover |
| **Auto-compact** | Fail-closed (circuit breaker) | Repeated failures indicate systematic issue |
| **External MCP servers** | Fail-open (mark unhealthy) | Don't block agent for one bad server |
| **ChromaDB** | Degrade to keyword search | Semantic search is enhancement, not core |
| **Notification channels** | Disable + alert | Bad channel shouldn't block execution |

### API Retry Strategy

Exponential backoff with jitter:
```
Attempt 1: 1s + jitter
Attempt 2: 2s + jitter
Attempt 3: 4s + jitter
Attempt 4: 8s + jitter
Attempt 5: 16s + jitter
```

After 3 consecutive failures: **model fallback** (Opus → Sonnet → Haiku)

### Circuit Breaker Pattern

```
CLOSED (normal) → failure threshold reached → OPEN (reject all)
                                                    │
                                            timeout expires
                                                    │
                                              HALF-OPEN (try one)
                                              ↙           ↘
                                          success        failure
                                             ↓               ↓
                                          CLOSED           OPEN
```

Applied to:
- **Auto-compact** — 3 failures → stop auto-compacting
- **MCP servers** — Mark unhealthy for 5 minutes, then retry
- **ChromaDB** — Degrade to keyword search
- **Notification channels** — Disable channel, alert admin

### Error Watermarking

Only surface errors that are newer than the last successful operation. This prevents stale error messages from repeatedly appearing after the issue has been resolved.

### Health Endpoint

`GET /api/health` returns:
- Overall status
- Per-subsystem circuit breaker states
- Last success/failure timestamps
- Degradation status (e.g., "ChromaDB: degraded to keyword search")

## Monitoring & Observability

### Prometheus Metrics (Task 056)

`GET /api/metrics` exposes:

| Metric | Type | Description |
|--------|------|-------------|
| `tela_active_users` | Gauge | Currently active users |
| `tela_requests_per_second` | Gauge | API request rate |
| `tela_query_duration_seconds` | Histogram | Query latency distribution |
| `tela_tool_calls_total` | Counter | Tool invocations by connection |
| `tela_errors_total` | Counter | Errors by type |
| `tela_cost_cents_total` | Counter | Accumulated API costs |

### Audit Trail

Every significant action is logged:
- Tool calls (with input, output, access decision)
- MCP requests (connection, tool, user)
- Knowledge operations (searches, reads)
- Schedule executions
- Approval decisions
- Login/logout events

Audit log supports:
- Filtering by user, agent, connection, action type, time range
- Access decision badges (allowed/denied/rate_limited)
- CSV export
- Admin sees all, regular users see only their own entries

### Cost Tracking

Per API call:
- Input/output tokens
- Model used
- Cost in cents
- Reserved vs actual output tokens
- Escalation retries (when max_tokens increased)
- Cache hit/miss rates (for fork cache optimization)

Per-user and per-team cost dashboards in admin UI.

## Data Protection

### GDPR Compliance (Task 056)
- Data export endpoint — users can export their data
- Right to deletion — admin can purge user data

### Credential Storage
- AES-256-GCM encryption for all stored credentials
- Per-value unique IV
- Key rotation support via admin UI
- Encryption key in environment variable, not in code/database
