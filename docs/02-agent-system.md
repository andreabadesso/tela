# Agent System

The agent system is Tela's core — it manages how AI agents are configured, how messages are routed to them, and how they execute.

## Agent Configuration

Agents are defined through the web UI and stored in the database. Each agent has:

| Field | Description |
|-------|-------------|
| `name` | Display name (e.g., "CTO Agent", "Support Agent") |
| `slug` | URL-safe identifier for @mentions |
| `model` | Claude model to use (opus, sonnet, haiku) |
| `system_prompt` | Instructions defining the agent's role and behavior |
| `mcp_servers` | JSON array of MCP server IDs the agent can access |
| `knowledge_sources` | JSON array of knowledge source IDs |
| `max_tokens` | Output token cap (default 8192, escalates to 32K if truncated) |
| `is_default` | Whether this agent handles unrouted messages |

### System Prompt Variables

System prompts support `{{variable}}` interpolation:

| Variable | Value |
|----------|-------|
| `{{company_name}}` | From system settings |
| `{{today}}` | Current date |
| `{{agent_name}}` | The agent's name |
| `{{user_name}}` | Current user's name |

### Agent Templates

The UI provides starter templates:

- **CTO** — Engineering leadership, technical decisions, team management
- **CEO** — Company strategy, cross-functional coordination
- **CFO** — Financial analysis, budgeting, cost control
- **Support** — Customer support, issue triage
- **Blank** — Empty template for custom agents

## Orchestrator

The orchestrator (`src/orchestrator/index.ts`) routes incoming messages to the appropriate agent.

### Routing Logic

1. **Explicit mention** — `@cto-agent what's the sprint status?` routes directly to the matched agent by slug
2. **Keyword matching** — Configurable keyword-to-agent mappings
3. **Default agent** — If no match, routes to the agent marked `is_default`

### Orchestrator-Level Tools

The orchestrator exposes MCP tools for cross-agent operations:

| Tool | Description |
|------|-------------|
| `ask_agent` | One agent calls another agent, passing a question and receiving a response |
| `list_agents` | Enumerate available agents and their capabilities |

## Multi-Agent Modes

### Direct Mode (Default)

Standard one-to-one: message goes to one agent, response streams back.

### Council Mode

Multiple agents process the same query in parallel:

1. User triggers council (or orchestrator decides based on query complexity)
2. Same message dispatched to N agents simultaneously
3. Each agent produces an independent response
4. Coordinator synthesizes results — no raw passthrough, prevents prompt injection propagation
5. Synthesized response returned to user

**Cost optimization**: Fork cache (task 062) builds a shared prefix (system prompt + history + query) that's byte-identical across agents, then appends agent-specific directives. API caches the prefix, so council costs ~1.1x a single agent instead of Nx.

### Background / Batch Mode

For async tasks that don't need immediate response:

1. User submits a task
2. Orchestrator assigns it to an agent, returns a `run_id`
3. Agent executes in background with full tool access
4. Session state persisted — can resume across process restarts
5. Results delivered via notification channel

### Structured Batch Workflows

For complex multi-step operations (task 066):

1. **Research & Plan** — Agent analyzes the task, produces a plan with cost estimate
2. **User Approval** — Plan presented via WebSocket, user must approve before workers spawn
3. **Spawn Workers** — Approved plan triggers parallel worker agents
4. **Track Progress** — Real-time status via WebSocket (progress table, completion %)
5. **Summary** — Coordinator produces final summary

Workers self-verify their output. Failed units don't block others. State persisted in `batch_runs` table.

## Task Checkout

To prevent multiple agents from working on the same task:

- `task_checkouts` table with unique index on `(task_ref, status='active')`
- Atomic checkout — only one agent can hold a task at a time
- Session ID tracking allows resumption if process restarts

## Agent Memory

Each agent maintains memories per user (task 071):

### Memory Types

| Type | Description |
|------|-------------|
| `user` | Facts about the user (role, preferences, expertise) |
| `feedback` | Corrections and validated approaches |
| `project` | Ongoing work, goals, deadlines |
| `reference` | External resource pointers |
| `preference` | Behavior configuration (tone, language, verbosity) |

### How It Works

1. **Context Injection** — Before each response, relevant memories (global + user-specific) are injected into the system prompt (~4K token cap)
2. **Proactive Saving via MCP Tools** — Agents are instructed in the system prompt to save important facts using the `remember` tool during their normal turn. No separate extraction subprocess.
3. **MCP Tools Available** — `remember`, `recall`, `forget`, `list_memories`, `get_user_context`

### Behavior Configuration

Per agent per user, stored in `agent_behavior_config`:
- Tone (formal, casual, technical)
- Language preference
- Verbosity level
- What name to call the user
- Topics to avoid
- Custom instructions

### Gating

Memory features only active when:
- `AGENT_MEMORY_ENABLED=true` (default: true)
- Memory MCP tools are injected for interactive sources (web, telegram, agent)

## Agent Service

The `AgentService` (`src/services/agent-service.ts`) is the execution engine:

1. Loads agent configuration from DB
2. Builds system prompt with variable interpolation
3. Builds budget-aware conversation history via `ConversationContextService`
4. Injects relevant memories (16KB cap)
5. Resolves governed MCP tools via gateway (filtered by agent's `mcp_servers` config)
6. Calls Claude Agent SDK `query()`
7. Logs conversation (only successful responses — errors are never logged)
8. See [Conversation & Context](./13-conversation-and-context.md) for full details on history management

## Output Token Management

Default `max_tokens: 8192` keeps costs controlled. If response is truncated (`stop_reason=max_tokens`), automatic retry with 32K cap. Per-agent configurable. Cost tracking logs reserved vs. actual tokens and escalation frequency.
