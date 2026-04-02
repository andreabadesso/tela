# Integrations

Tela connects to external services through MCP servers and direct API clients. All integrations are configured through the web UI and governed by the MCP gateway.

## Connection Management

Connections are managed from the **Connections** page in the UI:

- **Grid layout** — Each integration shown as a card with status indicator
- **OAuth flows** — Click "Connect" to start OAuth for supported services
- **Test button** — Verify connectivity and token validity
- **Token strategy** — `company` (shared) or `delegated` (per-user)

Connected services are automatically registered as MCP servers available to agents.

## Google Workspace

### Google Calendar

**Service**: `src/services/calendar.ts`
**Auth**: OAuth 2.0 (`googleapis`)
**Scopes**: `calendar.readonly`, `calendar.events`

| Tool | Description |
|------|-------------|
| `get_today_events` | Today's events across all calendars |
| `get_week_events` | This week's events |
| `get_event_details` | Full details for a specific event |
| `find_free_slots` | Available time slots |

Features:
- Multi-calendar support (primary + shared)
- Attendee information (name, email, response status)
- Recurring event handling
- Location and video link extraction

### Gmail

**Service**: `src/services/gmail.ts`
**Auth**: Shared OAuth with Calendar
**Scopes**: `gmail.readonly`, `gmail.send`

| Tool | Description |
|------|-------------|
| `get_unread` | Unread emails, optionally filtered by label |
| `search_email` | Search with Gmail query syntax |
| `read_email` | Full email content by ID |
| `get_threads` | Email threads from a sender over N days |
| `draft_email` | Create a draft (requires confirmation before send) |
| `send_email` | Send a confirmed draft |

Features:
- Email classification: urgent (keywords + priority senders), normal, ignorable (newsletters)
- Thread reconstruction by thread ID
- Plain text preferred, sanitized HTML fallback
- Attachment metadata (no download)
- **Safety**: Drafts require explicit user confirmation before sending

### Google Auth

**Service**: `src/services/google-auth.ts`

Manages the OAuth 2.0 lifecycle:
- Token storage (encrypted in DB)
- Automatic refresh on expiry
- Multi-scope authorization
- Re-authorization flow when new scopes needed

## GitHub

**Service**: `src/services/github.ts`
**Auth**: Personal access token or OAuth
**SDK**: `@octokit/rest`

| Tool | Description |
|------|-------------|
| `get_open_prs` | Open PRs for a repo (or all configured repos) |
| `get_pr_details` | Full PR details — diff stats, reviews, CI status |
| `get_recent_deploys` | Recent deployments with status |
| `get_incidents` | Open incidents/issues labeled as incidents |
| `get_ci_status` | CI/CD pipeline status for a repo |

Configuration:
- `GITHUB_TOKEN` — Access token
- `GITHUB_ORG` — Organization name
- `GITHUB_REPOS` — Comma-separated repo list

Features:
- Multi-repo support (query specific repo or all)
- PR data normalization (title, author, age, review status, CI, labels)
- Deploy tracking (version/tag, environment, status)

## Jira

**Service**: `src/services/jira.ts`
**Auth**: API token + email
**API**: REST v3

| Tool | Description |
|------|-------------|
| `get_sprint_status` | Current sprint progress for a squad |
| `get_blocked_tickets` | All blocked tickets across projects |
| `get_ticket` | Full ticket details by key |
| `get_velocity` | Sprint velocity over N sprints |
| `get_backlog_size` | Backlog item count for a squad |
| `get_overdue_tickets` | Overdue tickets across projects |
| `search_tickets` | Custom JQL search |
| `add_comment` | Add a comment to a ticket |

Configuration:
- `JIRA_BASE_URL` — Instance URL
- `JIRA_API_TOKEN` — API token
- `JIRA_USER_EMAIL` — Authentication email
- Squad mapping — Config mapping Jira projects to squad names

## ShipLens

**Service**: `src/services/shiplens.ts`
**Protocol**: MCP (SSE transport)
**Config**: `SHIPLENS_URL`, `SHIPLENS_API_KEY`

ShipLens provides engineering metrics. Tela connects via MCP client:

| Tool | Description |
|------|-------------|
| `latest_pulse` | Team health pulse |
| `stale_prs` | PRs that need attention |
| `dora_latest` | DORA metrics (deploy freq, lead time, change failure, MTTR) |
| `contributor_alerts` | Individual contributor anomalies |
| `attrition_risk` | Team attrition risk indicators |
| `pr_health` | PR review health metrics |
| `reviewer_ranking` | Top reviewers |
| `cross_team_coupling` | Cross-team dependency analysis |
| `before_after` | Compare metrics before/after an event |
| _35+ more tools_ | Auto-discovered via MCP `tools/list` |

Features:
- MCP-native connection (SSE or stdio transport)
- Auto-discovery of all available tools
- Health monitoring with auto-reconnect
- Graceful degradation when unavailable

## Telegram

**Service**: `src/services/telegram.ts`
**SDK**: Grammy
**Config**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

Telegram serves as both an input channel and notification delivery:

### Bot Commands

| Command | Description |
|---------|-------------|
| `/todo [text]` | Add task or list tasks |
| `/search [query]` | Search vault |
| `/remember [text]` | Quick capture to inbox |
| `/prep [name]` | Meeting prep for a person |
| `/read [path]` | Read vault note |
| `/status [squad]` | Sprint + engineering metrics |
| `/metrics` | DORA metrics dashboard |
| `/blocked` | All blockers (PRs, Jira, dependencies) |
| `/decision [topic]` | Structured decision framework |

### Features
- Chat ID restriction (single authorized chat)
- Auto-reconnect with exponential backoff
- Markdown/HTML message formatting
- Message threading for long conversations

## Slack

**Channel Adapter**: `src/channels/adapters/slack.ts`

Bidirectional Slack integration:
- Receive messages from Slack channels/DMs
- Send responses back to Slack
- Thread-aware conversations
- Channel-based routing to agents

## Communication Channels

Tela has a unified communication channel system (`src/channels/`) that provides bidirectional integration:

| Channel | Receive | Send | Thread Support |
|---------|---------|------|---------------|
| Telegram | Messages, commands | Responses, notifications | Yes |
| Slack | Messages, mentions | Responses, notifications | Yes |
| GitHub | Issue comments, PR comments | Responses, status updates | Yes |
| Jira | Issue updates, comments | Responses, comments | Yes |

### Channel Gateway

The gateway (`src/channels/gateway.ts`) provides a unified interface:
- Routes incoming messages from any channel to the orchestrator
- Delivers agent responses back to the originating channel
- Maintains thread context per channel per conversation
- Handles platform-specific formatting (Markdown, Slack blocks, etc.)

## Alert Systems

### PR Stale Alerts (Task 024)
- Check every 2 hours
- Alert on PRs open > 2 days without review activity
- Dedup: no re-alert within 2 days
- Grouped by squad with direct links

### Jira Blocked Ticket Alerts (Task 025)
- Check every 4 hours
- Alert on tickets blocked > 1 day
- Dedup: no re-alert within 2 days
- Grouped by squad with blocker reason

### ShipLens Anomaly Alerts (Task 026)
- Check every 6 hours
- Detect: activity drops, churn spikes, stale PR spikes, DORA regression
- Severity: warning (subtle) or alert (significant)
- Only alert on new anomalies (tracked in SQLite)
