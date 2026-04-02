# Runtime & Execution

Tela supports multiple agent execution backends and includes optimizations for streaming, context management, and cost control.

## Runtime Abstraction (Task 070)

The `AgentRuntime` interface decouples *where* agents run from *how* they're orchestrated.

```typescript
interface AgentRuntime {
  execute(params: RuntimeParams): Promise<RuntimeResult>
  status(runId: string): Promise<RunStatus>
  cancel(runId: string): Promise<void>
  logs(runId: string): AsyncIterable<string>
}
```

### Runtime Registry

`RuntimeRegistry` (`src/runtime/index.ts`) resolves which runtime to use:

```
Agent-level override → Environment config → Default fallback
```

### In-Process Runtime

**File**: `src/runtime/in-process.ts`
**Use**: Development, simple deployments

- Wraps `AgentService.process()` directly
- Runs in the main Node.js process
- Wall-clock timeout via `AbortController`
- Simplest setup, no isolation

### Agent OS Runtime

**File**: `src/runtime/agent-os.ts`
**Use**: Local production with lightweight isolation

- V8 isolates (~6ms cold start)
- Sandboxed execution environment
- Memory limits per isolate
- MCP access via host proxy

### Docker Runtime

**File**: `src/runtime/docker.ts`
**Use**: Full isolation, resource control

- Spawns container per agent run via Docker Engine API (`dockerode`)
- **Resource limits**: Memory, CPU, disk per container
- **Vault access**: Container-mounted vault (read-only)
- **MCP access**: Via host-networked proxy (`host.docker.internal:{port}/mcp/{serverId}`)
- No direct SQLite access from containers

### MCP Proxy

For Docker and Agent OS runtimes, agents can't directly access MCP servers. Instead:

1. Agent worker makes HTTP call to `host.docker.internal:{port}/internal/mcp-proxy/{serverId}/call`
2. Proxy receives the request on the host
3. Proxy routes through the governance gateway (full authorization pipeline)
4. Result forwarded back to the container

This preserves all governance controls even when agents run in isolation.

### Agent Worker

**File**: `src/agent-worker.ts`

Isolated entry point for Docker/Agent OS execution:
1. Receives execution params (agent config, prompt, context)
2. Calls Claude Agent SDK `query()`
3. Streams events back to host
4. Posts final result

### Agent Runs Table

All executions tracked in `agent_runs`:
- Agent ID, user ID
- Runtime used (in-process, agent-os, docker)
- Status (pending, running, completed, failed, cancelled)
- Input/output
- Container ID (for Docker)
- Resource usage (CPU, memory, duration)
- Timestamps

## Streaming (Task 060)

### Generator-Based Query Loop

The execution engine uses generators for mid-stream tool execution:

- **Read-only tools** execute in parallel
- **Write tools** execute exclusively (one at a time)

### WebSocket Event Types

| Event | Description |
|-------|-------------|
| `thinking` | Model is processing (thinking indicator) |
| `text` | Text chunk (paragraph-level) |
| `token` | Per-token streaming (typewriter effect) |
| `tool_start` | Tool invocation beginning |
| `tool_progress` | Tool execution update |
| `tool_result` | Tool execution complete |
| `done` | Response complete |
| `error` | Error occurred |
| `batch_plan` | Batch workflow plan for review |
| `batch_approve` | User approved batch plan |
| `batch_status` | Batch worker progress update |

### Terminal States

| State | Description |
|-------|-------------|
| `completed` | Normal completion |
| `aborted` | User cancelled |
| `error` | Unrecoverable error |
| `context_overflow` | Context window exceeded |
| `max_turns` | Turn limit reached |

## Conversation Compaction (Task 061)

A 6-layer strategy manages conversation context:

### Layer 1: Microcompact (Every Turn)
- No LLM call needed
- Clears old tool results (keep only latest)
- Removes redundant system messages
- Runs automatically on every turn

### Layer 2: Auto-Compact (At 70% Context)
- Triggered when context reaches 70% of window
- Haiku call generates structured summary of older conversation
- Summary replaces detailed older messages
- Preserves key decisions, facts, and context

### Layer 3: Reactive (On `prompt_too_long`)
- Emergency response when API returns context overflow
- Strips oldest 30% of messages
- Retries the request

### Layer 4: Circuit Breaker
- If auto-compact fails 3 consecutive times → stop attempting
- Prevents infinite retry loops
- Falls back to reactive compaction only

### Layer 5: Post-Restore
- After compaction, re-read the 3 most recently referenced files
- Ensures agent still has relevant context after summarization

### Layer 6: Context Tracking
- Token counts per turn
- Percentage of context window used
- Helps predict when compaction will be needed

## Cost Optimization

### Output Token Capping (Task 068)

- **Default**: `max_tokens: 8192`
- **Escalation**: If response truncated (`stop_reason=max_tokens`), retry with 32K cap
- **Per-agent**: Configurable cap per agent
- **Tracking**: Log reserved vs actual tokens, escalation frequency, measure savings

### Fork Cache (Task 062)

Optimizes council and batch modes:

1. Build shared prefix: system prompt + conversation history + query (byte-identical across agents)
2. Append agent-specific directive
3. API caches the shared prefix
4. Subsequent agents read from cache

**Result**: Council of N agents costs ~1.1x a single agent, not Nx.

Tracking:
- Cache hit/miss rates logged in `cost_events`
- Per-council cost comparison

### Deferred Tool Loading (Task 064)

Reduces system prompt size by lazy-loading tool schemas:

- **Always loaded**: Core vault tools + `tool_search` meta-tool
- **Deferred**: Knowledge tools, external MCP tools
- **Discovery**: `tool_search` finds tools by keyword scoring
- **Caching**: Schema cached per session after first load
- **Savings**: 40-60% reduction in system prompt tokens

### Budget Enforcement (Task 055)

- **Soft threshold** (default 80%): Warning included in agent response
- **Hard threshold** (default 100%): Execution paused, approval required
- Scoped to: user, team, role, agent, or global
- Period: daily, weekly, or monthly

## Startup Optimization (Task 069)

### Parallel Initialization

Service startup parallelized:
- Knowledge adapters init async
- Job registry setup async
- API preconnect run async
- MCP server connections async

### Lazy Loading

Heavy modules loaded on first use:
- ChromaDB client
- gray-matter (frontmatter parser)
- Large MCP server connections

### Fast Health Path

`GET /api/health` responds immediately without waiting for full service initialization.

### Timing

Startup timing logged per phase. Target: >30% cold start reduction vs. sequential init.
