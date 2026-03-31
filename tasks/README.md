# Tela — Task Specs

The AI operating system for companies. Built with `@anthropic-ai/claude-agent-sdk`. Multi-agent orchestration, pluggable knowledge sources, OAuth connection management, governed MCP access, and a web UI for 140+ users.

## Phases

| Phase | Name | Tasks | Status |
|-------|------|-------|--------|
| 1 | MVP | 001–010 | **done** |
| 2 | Integrations | 011–020 | **done** |
| 3 | Engineering Intelligence | 021–028 | **done** |
| 4 | Advanced Autonomy | 029–035 | **done** |
| 5 | Platform | 036–046 | **done** |
| 6 | Enterprise | 047–058 | **pending** |
| 7 | Agent Runtime | 060–069 | **pending** |

---

## Phase 1 — MVP

Core loop: Telegram bot + vault read/write + git sync + scheduled briefings.

### Dependency Graph

```
001 Project Scaffolding
 ├── 002 Vault Filesystem Tools
 │    ├── 003 Git Sync Layer
 │    └── 005 Agent Core (also depends on 004)
 │         ├── 006 Scheduled Jobs Framework
 │         │    ├── 007 Morning Briefing (also depends on 002, 004)
 │         │    └── 008 End of Day (also depends on 002, 003, 004)
 │         └── 009 Basic Telegram Commands (also depends on 002, 003, 004)
 └── 004 Telegram Bot Setup
      └── 005 Agent Core (see above)

010 Testing & Deployment (depends on all)
```

### Task List

| ID | Title | Deps | Effort | Status |
|----|-------|------|--------|--------|
| [001](001.md) | Project scaffolding and configuration | none | medium | done |
| [002](002.md) | Vault filesystem tools | 001 | medium | done |
| [003](003.md) | Git sync layer | 002 | medium | done |
| [004](004.md) | Telegram bot setup | 001 | medium | done |
| [005](005.md) | Agent core with claude-agent-sdk | 002, 004 | large | done |
| [006](006.md) | Scheduled jobs framework | 005 | small | done |
| [007](007.md) | Morning briefing job | 006, 002, 004 | medium | done |
| [008](008.md) | End of day prompt and processing | 006, 002, 003, 004, 005 | large | done |
| [009](009.md) | Basic Telegram commands | 005, 002, 003, 004 | medium | done |
| [010](010.md) | Testing and deployment | 001–009 | large | done |

### Critical Path

```
001 → 002 → 005 → 006 → 007 (morning briefing working end-to-end)
001 → 004 ↗
```

### Parallelizable Work

After 001 is done, **002** and **004** can be built in parallel. After both are done, **003** and **005** can progress together.

---

## Phase 2 — Integrations (011–020)

Google Calendar, Gmail, meeting prep, daily digest, week ahead/review, transcript processing, knowledge ingestion.

### Dependency Graph

```
011 Google Calendar (deps: 001, 005)
 ├── 012 Gmail (deps: 001, 005, 011 — shares OAuth)
 │    ├── 014 Daily Digest 20:00 (deps: 006, 012, 011, 004)
 │    ├── 019 Email Send (deps: 012)
 │    └── 020 Midday Check 12:00 (deps: 006, 012, 011, 004)
 ├── 013 Meeting Prep (deps: 011, 002, 005, 004)
 ├── 015 Week Ahead Sunday 20:00 (deps: 006, 011, 002, 004)
 └── 017 Transcript Processing (deps: 005, 002, 003, 004, 011)

016 Week Review Friday 17:00 (deps: 006, 002, 004, 005)
018 Knowledge Ingestion (deps: 005, 002, 003, 004)
```

### Task List

| ID | Title | Deps | Effort | Status |
|----|-------|------|--------|--------|
| [011](011.md) | Google Calendar integration | 001, 005 | medium | done |
| [012](012.md) | Gmail integration | 001, 005, 011 | medium | done |
| [013](013.md) | Meeting prep automation | 011, 002, 005, 004 | medium | done |
| [014](014.md) | Daily digest job (20:00) | 006, 012, 011, 004 | small | done |
| [015](015.md) | Week ahead job (Sunday 20:00) | 006, 011, 002, 004 | small | done |
| [016](016.md) | Week review job (Friday 17:00) | 006, 002, 004, 005 | medium | done |
| [017](017.md) | Transcript processing pipeline | 005, 002, 003, 004, 011 | large | done |
| [018](018.md) | Knowledge ingestion | 005, 002, 003, 004 | large | done |
| [019](019.md) | Email send capability | 012 | small | done |
| [020](020.md) | Midday check job (12:00) | 006, 012, 011, 004 | small | done |

### Critical Path

```
001 → 005 → 011 → 012 → 014 (daily digest end-to-end)
001 → 005 → 011 → 013 (meeting prep end-to-end)
005 → 017 (transcript processing — highest value)
```

### Parallelizable Work

After 011 (Calendar) is done: **012**, **013**, **015**, **017** can progress in parallel. **016** and **018** only depend on Phase 1 tasks, so they can start as soon as Phase 1 is complete.

---

## Phase 3 — Engineering Intelligence (021–028)

ShipLens MCP, Jira, GitHub, PR alerts, ticket alerts, anomaly detection, engineering metrics in briefing.

### Dependency Graph

```
021 ShipLens MCP Client (deps: 005)
 ├── 024 PR Stale Alerts (deps: 021 or 023, 004, 006)
 ├── 026 ShipLens Anomaly Alerts (deps: 021, 004, 006)
 └── 027 Enhanced Morning Briefing (deps: 007, 021, 022, 023, 011)
      └── 028 Telegram Eng Commands (deps: 021, 022, 023, 004, 005)

022 Jira Integration (deps: 001, 005)
 ├── 025 Blocked Ticket Alerts (deps: 022, 004, 006)
 └── 027 (see above)

023 GitHub Integration (deps: 001, 005)
 ├── 024 (see above)
 └── 027 (see above)
```

### Task List

| ID | Title | Deps | Effort | Status |
|----|-------|------|--------|--------|
| [021](021.md) | ShipLens MCP client | 005 | large | done |
| [022](022.md) | Jira integration | 001, 005 | medium | done |
| [023](023.md) | GitHub integration | 001, 005 | medium | done |
| [024](024.md) | PR stale alerts | 021 or 023, 004, 006 | small | done |
| [025](025.md) | Jira blocked ticket alerts | 022, 004, 006 | small | done |
| [026](026.md) | ShipLens anomaly alerts | 021, 004, 006 | medium | done |
| [027](027.md) | Enhanced morning briefing with engineering data | 007, 021, 022, 023, 011 | medium | done |
| [028](028.md) | Telegram engineering commands | 021, 022, 023, 004, 005 | medium | done |

### Critical Path

```
005 → 021 → 027 (ShipLens data in morning briefing)
001 → 022 → 025 (Jira blocked alerts)
001 → 023 → 024 (PR stale alerts)
```

### Parallelizable Work

**021**, **022**, and **023** are fully independent and can be built in parallel once Phase 1 is done. After all three are complete, **024**, **025**, **026** can also run in parallel. **027** and **028** need all three integrations.

---

## Phase 4 — Advanced Autonomy (029–035)

Vector store, semantic search, pattern learning, proactive suggestions, decision tracking, smart notifications, vault self-maintenance.

### Dependency Graph

```
029 Vector Store Setup (deps: 002, 003)
 ├── 030 Enhanced Knowledge Ingestion (deps: 018, 029)
 └── 035 Self-Maintaining Vault (deps: 002, 029)

031 Pattern Learning (deps: 005, 006)
 ├── 032 Proactive Suggestions (deps: 031, 002, 006)
 └── 034 Smart Notification Filtering (deps: 031, 004)

033 Decision Review Tracking (deps: 002, 004, 006)
```

### Task List

| ID | Title | Deps | Effort | Status |
|----|-------|------|--------|--------|
| [029](029.md) | Vector store setup (ChromaDB) | 002, 003 | large | done |
| [030](030.md) | Enhanced knowledge ingestion with semantic search | 018, 029 | medium | done |
| [031](031.md) | Pattern learning | 005, 006 | medium | done |
| [032](032.md) | Proactive suggestions | 031, 002, 006 | large | done |
| [033](033.md) | Decision review tracking | 002, 004, 006 | small | done |
| [034](034.md) | Smart notification filtering | 031, 004 | medium | done |
| [035](035.md) | Self-maintaining vault | 002, 029 | medium | done |

### Critical Path

```
002 → 029 → 030 (semantic knowledge ingestion)
005 → 031 → 032 (proactive suggestions)
005 → 031 → 034 (smart notifications)
```

### Parallelizable Work

**029**, **031**, and **033** are independent and can be built in parallel. After 029: **030** and **035** can run in parallel. After 031: **032** and **034** can run in parallel.

---

## Phase 5 — Platform (036–046)

Transform from personal CTO assistant into a configurable company OS with web UI, OAuth connections, multi-agent orchestration, pluggable knowledge sources, and visual scheduling.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for full design.

### Dependency Graph

```
036 API Layer
 ├── 037 Database Schema (extends SQLite)
 │    ├── 039 Agent Config UI (deps: 037, 038)
 │    ├── 040 Connection Management + OAuth (deps: 037, 038)
 │    ├── 041 Knowledge Source Adapters (deps: 037, 038, 029)
 │    ├── 043 Schedules UI (deps: 037, 038, 039)
 │    ├── 044 Audit Log + Settings (deps: 037, 038)
 │    └── 045 Notification Channels (deps: 037, 043, 044)
 ├── 038 Frontend Shell (deps: 036)
 │    ├── 039, 040, 041, 043, 044 (all UI pages)
 │    └── 046 Docker Prod Build (deps: 036, 037, 038)
 └── 042 Multi-Agent Orchestrator (deps: 039, 040, 041)
```

### Task List

| ID | Title | Deps | Effort | Status |
|----|-------|------|--------|--------|
| [036](036.md) | API layer (Hono + WebSocket) | 005 | medium | done |
| [037](037.md) | Database schema for platform | 036 | medium | done |
| [038](038.md) | Frontend shell (React + assistant-ui + Shadcn) | 036 | large | done |
| [039](039.md) | Agent configuration UI | 037, 038 | medium | done |
| [040](040.md) | Connection management with OAuth | 037, 038 | large | done |
| [041](041.md) | Knowledge source adapters | 037, 038, 029 | large | done |
| [042](042.md) | Multi-agent orchestrator | 039, 040, 041 | large | done |
| [043](043.md) | Schedules UI (visual cron) | 037, 038, 039 | medium | done |
| [044](044.md) | Audit log + settings | 037, 038 | small | done |
| [045](045.md) | Notification channels (pluggable) | 037, 043, 044 | medium | done |
| [046](046.md) | Docker production build + first deploy | 036, 037, 038 | medium | done |

### Critical Path

```
036 → 037 → 038 → 039 → 042 (multi-agent working end-to-end via web UI)
036 → 037 → 038 → 040 (OAuth connections from browser)
036 → 037 → 038 → 046 (deployable build)
```

### Parallelizable Work

After 036+037+038 are done (API + DB + frontend shell), these can all run in parallel:
- **039** (agents UI)
- **040** (connections/OAuth)
- **041** (knowledge adapters)
- **044** (audit log)

After 039: **043** (schedules) can start.
After 039+040+041: **042** (orchestrator) can start.
After 043+044: **045** (notifications) can start.
**046** (Docker) can start as soon as 036+037+038 are done.

### Suggested Build Order (optimized for showing progress fast)

1. **036** API Layer — foundation
2. **037** DB Schema — unlock everything
3. **038** Frontend Shell — now you can SEE something
4. **046** Docker Build — deploy early, iterate deployed
5. **039** + **044** in parallel — agents page + audit log (quick wins)
6. **040** OAuth — biggest UX improvement
7. **041** Knowledge Adapters — unlock multi-source
8. **043** Schedules — replace hardcoded cron
9. **042** Multi-Agent — the crown jewel
10. **045** Notifications — polish

---

## Phase 6 — Enterprise (047–058)

Multi-user deployment for 140 employees. Auth, RBAC, MCP governance, per-user permissions, budget controls, and onboarding.

**Core principle:** When an agent runs on behalf of a user, the MCP servers it can access are the INTERSECTION of the agent's configured servers, the user's role-based permissions, and healthy connections. A trainee literally cannot see financial tools — they're filtered out before the LLM runs.

### Architecture Decision: Custom MCP Gateway

Evaluated [Deco Studio](https://github.com/decocms/studio) as MCP control plane. Decided to build custom because:
- Deco doesn't support per-user MCP tool filtering
- No user-delegated OAuth tokens
- No data classification on tools
- License restricts future SaaS use
- We need in-process gateway (no network hop)

Auth library: **better-auth** (TypeScript, Hono adapter, SSO/OIDC, MIT license).

### Dependency Graph

```
047 Auth Database Schema
 ├── 048 Authentication (better-auth + Google SSO)
 │    ├── 054 Per-User Audit Trail
 │    └── 058 Onboarding Flow
 └── 052 Governance Policies Schema
      └── 049 RBAC Engine + Permission Resolution
           ├── 050 MCP Governance Gateway ←── THE CRITICAL TASK
           │    ├── 051 Governance Policies Admin UI
           │    ├── 053 User-Delegated Connections
           │    ├── 055 Per-User Budget & Rate Limiting
           │    └── 057 MCP Server Registry (Dynamic Discovery)
           └── 056 Enterprise Hardening
```

### Task List

| ID | Title | Deps | Effort | Status |
|----|-------|------|--------|--------|
| [047](047.md) | Auth & identity database schema | 037 | medium | pending |
| [048](048.md) | Authentication (better-auth + Google SSO) | 047 | large | pending |
| [049](049.md) | RBAC engine + permission resolution | 047, 048 | medium | pending |
| [050](050.md) | MCP governance gateway | 049 | large | pending |
| [051](051.md) | Governance policies admin UI | 049, 050 | medium | pending |
| [052](052.md) | Governance policies database schema | 047 | small | pending |
| [053](053.md) | User-delegated connections | 050 | medium | pending |
| [054](054.md) | Per-user audit trail | 048, 050 | small | pending |
| [055](055.md) | Per-user budget & rate limiting | 050, 054 | medium | pending |
| [056](056.md) | Enterprise hardening | 048, 050, 054, 055 | large | pending |
| [057](057.md) | MCP server registry (dynamic discovery) | 050 | medium | pending |
| [058](058.md) | Onboarding flow & company setup wizard | 048, 049, 050, 051 | medium | pending |

### Critical Path

```
047 → 052 → 049 → 050 (MCP gateway enforcing permissions — "trainee can't see financial data")
047 → 048 (140 users can log in)
```

### Implementation Order

**Week 1 — Foundation:**
1. **047** Auth schema + **052** Governance schema (parallel, 2-3 days)
2. **048** Authentication (4-5 days, start mid-week)

**Week 2 — Governance core:**
3. **049** RBAC engine (3-4 days)
4. **050** MCP Gateway (start mid-week, 5-7 days)

**Week 3 — Gateway completion + UI:**
5. **050** continued
6. **051** Policies admin UI + **054** Per-user audit (parallel)
7. **057** MCP server registry

**Week 4 — Polish:**
8. **053** User-delegated connections
9. **055** Budget & rate limiting
10. **058** Onboarding wizard
11. **056** Enterprise hardening

---

## Phase 7 — Agent Runtime (060–069)

Production-grade agent execution: streaming tool execution, context compaction, prompt cache optimization, defense-in-depth, and cost control. Patterns derived from cc-tips production agent orchestration docs.

**Core principle:** The agent runtime should be as good as the model allows — streaming reduces latency, compaction enables long sessions, deferred loading saves tokens, and defense layers protect against prompt injection.

### Dependency Graph

```
069 Startup Optimization (no deps — can start immediately)

060 Streaming Tool Execution (deps: 036, 042)
 ├── 061 Conversation Compaction (deps: 060)
 ├── 062 Fork Cache Optimization (deps: 042, 060)
 ├── 065 Circuit Breakers & Error Resilience (deps: 060)
 ├── 066 Structured Batch Workflows (deps: 042, 060)
 └── 068 Output Token Capping (deps: 060)

064 Deferred Tool Loading (deps: 042)

063 Tool Execution Pipeline (deps: 050)
 └── 067 Prompt Injection Defense (deps: 050, 063)
```

### Task List

| ID | Title | Deps | Effort | Status |
|----|-------|------|--------|--------|
| [060](060.md) | Streaming tool execution | 036, 042 | large | pending |
| [061](061.md) | Conversation compaction | 060 | large | pending |
| [062](062.md) | Fork cache optimization for multi-agent | 042, 060 | medium | pending |
| [063](063.md) | Tool execution pipeline & permission hardening | 050 | medium | pending |
| [064](064.md) | Deferred tool loading | 042 | medium | pending |
| [065](065.md) | Circuit breakers & error resilience | 060 | small | pending |
| [066](066.md) | Structured batch workflows with approval gates | 042, 060 | medium | pending |
| [067](067.md) | Prompt injection defense layers | 050, 063 | medium | pending |
| [068](068.md) | Output token capping & cost optimization | 060 | small | pending |
| [069](069.md) | Startup optimization & parallel prefetch | none | small | pending |

### Critical Path

```
060 → 061 (streaming + compaction = long-running agent sessions)
060 → 062 (streaming + cache = cost-efficient multi-agent)
050 → 063 → 067 (governance → tool pipeline → injection defense)
```

### Parallelizable Work

- **069** has no dependencies — start immediately
- **064** only needs 042 (already done) — start immediately
- **063** only needs 050 (Phase 6) — start as soon as MCP gateway is done
- After **060**: **061**, **062**, **065**, **066**, **068** can all run in parallel

### Suggested Build Order

1. **069** Startup optimization — quick win, no deps
2. **064** Deferred tool loading — quick win, immediate token savings
3. **068** Output token capping — quick win, immediate cost savings
4. **060** Streaming tool execution — the big one, unlocks everything
5. **065** Circuit breakers — small, hardens the streaming loop
6. **061** Conversation compaction — enables long sessions
7. **062** Fork cache — cost optimization for multi-agent
8. **066** Structured batch — better UX for batch operations
9. **063** Tool execution pipeline — depends on Phase 6 MCP gateway
10. **067** Prompt injection defense — depends on 063
