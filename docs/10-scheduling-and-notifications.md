# Scheduling & Notifications

Tela provides a cron-based scheduling system for recurring agent tasks, with pluggable notification channels for delivering results.

## Scheduling System

### Job Registry

The `JobRegistry` (`src/jobs/registry.ts`) manages scheduled jobs using `node-cron`:

- **Timezone-aware** — All cron expressions evaluated in configured timezone (default: `America/Sao_Paulo`)
- **Dynamic registration** — Schedules added/removed from DB without server restart
- **Health monitoring** — Track last run, success/failure counts
- **Auto-disable** — 3 consecutive failures → disable job + alert

### Schedule Configuration

Schedules are created from the UI and stored in the database:

| Field | Description |
|-------|-------------|
| `name` | Human-readable name |
| `cron_expression` | Standard cron syntax (5 fields) |
| `prompt` | The message/instruction sent to the agent |
| `agent_id` | Which agent executes the job |
| `channels` | Notification channels for the result |
| `enabled` | On/off toggle |
| `timezone` | Timezone for cron evaluation |

### Schedule Templates

The UI provides 12 pre-built templates:

| Template | Cron | Description |
|----------|------|-------------|
| Morning Briefing | `0 8 * * 1-5` | Daily priorities, meetings, carry-overs |
| Midday Check | `0 12 * * 1-5` | Silent check — only alerts if something needs attention |
| Daily Digest | `0 20 * * *` | Evening summary: emails, PRs, tomorrow's meetings |
| End of Day | `0 18 * * 1-5` | Prompted reflection, vault updates |
| Week Ahead | `0 20 * * 0` | Sunday preview of the coming week |
| Week Review | `0 17 * * 5` | Friday retrospective with patterns and velocity |
| PR Stale Alert | `0 */2 * * *` | Every 2h: PRs open > 2 days without review |
| Blocked Tickets | `0 */4 * * *` | Every 4h: Jira tickets blocked > 1 day |
| Anomaly Detection | `0 */6 * * *` | Every 6h: ShipLens anomaly check |
| Meeting Prep | `*/15 * * * *` | Every 15min: prep for upcoming meetings |
| Decision Review | `0 9 * * 1-5` | Daily: check for decision review dates |
| Vault Health | `0 8 * * 6` | Saturday: orphan notes, broken links, stale items |

### Run Now

Each schedule has a "Run Now" button that triggers immediate execution outside the cron cycle.

### History

Per-schedule execution history:
- Timestamp, duration
- Status (success/error)
- Output/error message
- Triggered by (cron or manual)

## Built-In Jobs

### Morning Briefing (Task 007, enhanced by Task 027)

**Schedule**: Daily at 08:00, weekdays
**Data Sources** (fetched in parallel):
- Today's daily note (create from template if missing)
- Pending tasks from vault
- 90-day roadmap
- Yesterday's note (carry-overs)
- Calendar events for today
- DORA metrics (current vs last week + trend arrows)
- Stale PRs (count + top 3)
- Blocked tickets
- Contributor alerts

**Output**: 5 sections — priorities (max 3), attention items, meetings, carry-over, daily thought. Appended to today's daily note.

### End of Day (Task 008)

**Schedule**: Weekdays at 18:00
**Flow**:
1. Prompt user: "How was the day?"
2. Collect multi-message response (2min silence timeout, 2hr total)
3. Process with agent
4. Update vault: daily note (EOD section), person docs, decisions
5. Git commit all changes
6. Send summary

### Midday Check (Task 020)

**Schedule**: Daily at 12:00
**Behavior**: Silent by default — only notifies if:
- Urgent emails arrived since morning
- Calendar changes detected
- Alerts triggered

### Daily Digest (Task 014)

**Schedule**: Daily at 20:00
**Content**: Unread company emails (top 3 by urgency), PRs needing review, tomorrow's meetings, meeting prep preview, day intensity forecast.

### Week Ahead (Task 015)

**Schedule**: Sunday at 20:00
**Content**: Per-day breakdown (Mon-Fri) with meetings, 1:1s highlighted, deadlines from vault. Claude analyzes week + roadmap for focus suggestions.

### Week Review (Task 016)

**Schedule**: Friday at 17:00
**Content**: Completed items, pending items, decisions made, what shifted vs plan. Claude generates patterns/risks. Saved to `Work/Operacao/Semanas/YYYY-WNN.md`.

### Meeting Prep (Task 013)

**Schedule**: Every 15 minutes
**Flow**:
1. Poll calendar for events starting within 30min
2. Skip events with "no prep needed" tag
3. Deduplicate (don't re-prep same event)
4. Match attendees to person docs in vault
5. Generate prep sheet: attendees, context, last meeting, pending items, suggested questions

### Decision Review (Task 033)

**Schedule**: Weekdays at 09:00
**Flow**:
1. Parse decision records from `Work/Decisoes/`
2. Check for review dates that are today or overdue
3. Notify with original context + "Is this still valid?"
4. User can respond: "Still valid", "Needs revision", "Obsolete"

### Vault Health (Task 035)

**Schedule**: Saturday at 08:00
**Checks**:
- Orphaned notes (no incoming links)
- Broken wikilinks
- Stale action items (> 30 days old)
- Stale person docs (> 30 days without update)
- Metric inconsistencies

**Modes**: Report only (Telegram summary) or auto-fix (fix broken links, move stale items).

## Notification Channels

### Channel Interface

```typescript
interface NotificationChannel {
  id: string
  name: string
  type: 'telegram' | 'slack' | 'email' | 'webhook' | 'web'
  send(message: NotificationMessage): Promise<void>
  test(): Promise<boolean>
}
```

### Channel Types

| Channel | Implementation | Config |
|---------|---------------|--------|
| **Telegram** | Grammy bot API | Bot token, chat ID |
| **Slack** | Slack Web API | Webhook URL or bot token + channel |
| **Email** | Nodemailer (SMTP) | SMTP host, port, credentials, recipient |
| **Webhook** | HTTP POST | URL, headers, optional auth |
| **Web** | WebSocket push | In-app, no config needed |

### Web Notifications

In-app notifications via WebSocket:
- Notification bell icon with unread badge count
- Real-time push without polling
- Persistent notification history
- Mark as read/dismiss

### Channel Configuration

Channels are configured from the **Channels** page in the UI:
- Add/remove notification channels
- Test connectivity
- Enable/disable individual channels
- Per-schedule channel targeting (each schedule picks which channels receive results)

## Smart Notification Filtering (Task 034)

### Learning Phase

After 4+ weeks of tracking per-notification engagement:

| Signal | Response Time | Action |
|--------|-------------|--------|
| High engagement | < 5 min | Keep, consider escalation |
| Delayed engagement | Later response | Consider batching or timing shift |
| Low engagement | Consistently ignored | Suppress, re-test every 2 weeks |

### Adaptive Rules

- **Suppress** — Consistently ignored notification types get suppressed
- **Timing** — Shift delivery to when user typically responds
- **Batching** — Combine low-engagement notifications into digests
- **Escalation** — High-engagement items get priority delivery

### Safety

- **Never suppress** incident-level alerts
- **Transparency** — `/notification-settings` shows active rules and rationale
- **User overrides** — Can force-enable any suppressed type
- **Weekly summary** — Report of what was suppressed and why

## Pattern Learning (Task 031)

### What's Tracked

Per interaction:
- **What**: Topic summary
- **When**: Timestamp, day of week, time of day
- **Type**: Question, command, decision, check-in
- **Context**: Tool used, data requested

### Analysis (After 4+ Weeks)

Claude analyzes patterns:
- **Temporal** — Day-of-week correlations, time-of-day habits
- **Frequency** — Regular queries, gaps in routine
- **Behavioral** — Timing of actions vs decisions
- **Gap detection** — Neglected people, topics, or processes

### Delivery

- Weekly pattern report in Friday review
- Relevant insights surfaced in morning briefing
- `/forget-patterns` command for data deletion
- All data local (never sent externally)

## Proactive Suggestions (Task 032)

Engine runs during morning briefing or on-demand:

### Suggestion Types

| Category | Example |
|----------|---------|
| **People** | "You haven't met with [person] in 3 weeks" |
| **Decisions** | "Decision [X] has a review date today" |
| **Roadmap** | "Milestone [Y] was planned for this week but has no progress" |
| **Patterns** | "You usually review metrics on Monday but haven't this week" |

### Delivery

- Top 3-5 ranked suggestions in morning briefing
- Standalone `/suggestions` command
- Feedback loop: dismiss ("Not relevant") or act → system learns
