# Tela — Task Specs

The AI operating system for companies. Built with `@anthropic-ai/claude-agent-sdk`. Multi-agent orchestration, pluggable knowledge sources, OAuth connection management, governed MCP access, and a web UI.

## Phases

| Phase | Name | Tasks | Status |
|-------|------|-------|--------|
| 5 | Platform | 036–046 | **done** |
| 6 | Enterprise | 047–058 | **in-progress** (055, 056 remain) |
| 7 | Agent Runtime | 060–069 | **pending** |
| 8 | Agent Orchestration & Isolation | 070–07x | **pending** |

Earlier phases (1–4) built the core: vault tools, Telegram bot, Git sync, Google Calendar/Gmail, Jira, GitHub, ShipLens, vector search, pattern learning, and notification filtering. All complete and integrated.

---

## Phase 5 — Platform (036–046)

Web UI, OAuth connections, multi-agent orchestration, pluggable knowledge sources, and visual scheduling.

### Task List

| ID | Title | Deps | Effort | Status |
|----|-------|------|--------|--------|
| [036](036.md) | API layer (Hono + WebSocket) | — | medium | done |
| [037](037.md) | Database schema for platform | 036 | medium | done |
| [038](038.md) | Frontend shell (React + assistant-ui + Shadcn) | 036 | large | done |
| [039](039.md) | Agent configuration UI | 037, 038 | medium | done |
| [040](040.md) | Connection management with OAuth | 037, 038 | large | done |
| [041](041.md) | Knowledge source adapters | 037, 038 | large | done |
| [042](042.md) | Multi-agent orchestrator | 039, 040, 041 | large | done |
| [043](043.md) | Schedules UI (visual cron) | 037, 038, 039 | medium | done |
| [044](044.md) | Audit log + settings | 037, 038 | small | done |
| [045](045.md) | Notification channels (pluggable) | 037, 043, 044 | medium | done |
| [046](046.md) | Docker production build + first deploy | 036, 037, 038 | medium | done |

---

## Phase 6 — Enterprise (047–058)

Multi-user deployment. Auth, RBAC, MCP governance, per-user permissions, budget controls, and onboarding.

**Core principle:** When an agent runs on behalf of a user, the MCP servers it can access are the INTERSECTION of the agent's configured servers, the user's role-based permissions, and healthy connections. A trainee literally cannot see financial tools — they're filtered out before the LLM runs.

### Task List

| ID | Title | Deps | Effort | Status |
|----|-------|------|--------|--------|
| [047](047.md) | Auth & identity database schema | 037 | medium | done |
| [048](048.md) | Authentication (better-auth + Google SSO) | 047 | large | done |
| [049](049.md) | RBAC engine + permission resolution | 047, 048 | medium | done |
| [050](050.md) | MCP governance gateway | 049 | large | done |
| [051](051.md) | Governance policies admin UI | 049, 050 | medium | done |
| [052](052.md) | Governance policies database schema | 047 | small | done |
| [053](053.md) | User-delegated connections | 050 | medium | done |
| [054](054.md) | Per-user audit trail | 048, 050 | small | done |
| [055](055.md) | Per-user budget & rate limiting | 050, 054 | medium | **in-progress** (~60%) |
| [056](056.md) | Enterprise hardening | 048, 050, 054, 055 | large | **in-progress** (~40%) |
| [057](057.md) | MCP server registry (dynamic discovery) | 050 | medium | done |
| [058](058.md) | Onboarding flow & company setup wizard | 048, 049, 050, 051 | medium | done |

---

## Phase 7 — Agent Runtime (060–069)

Production-grade agent execution: streaming tool execution, context compaction, prompt cache optimization, defense-in-depth, and cost control.

### Dependency Graph

```
069 Startup Optimization (no deps)

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

### Suggested Build Order

1. **069** Startup optimization — quick win, no deps
2. **064** Deferred tool loading — immediate token savings
3. **068** Output token capping — immediate cost savings
4. **060** Streaming tool execution — unlocks everything
5. **065** Circuit breakers — hardens the streaming loop
6. **061** Conversation compaction — enables long sessions
7. **062** Fork cache — cost optimization for multi-agent
8. **066** Structured batch — better UX for batch operations
9. **063** Tool execution pipeline — depends on MCP gateway
10. **067** Prompt injection defense — depends on 063

---

## Phase 8 — Agent Orchestration & Isolation (070–07x)

Pluggable agent runtimes, containerized execution, and production-grade isolation.

### Task List

| ID | Title | Deps | Effort | Status |
|----|-------|------|--------|--------|
| [070](070.md) | Agent runtime abstraction (pluggable execution backends) | 042, 046 | large | pending |
