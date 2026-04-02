# Conversation & Context Management

How Tela manages conversation history, context windows, token budgets, and compaction — the system that ensures agents never exceed model limits while maintaining useful conversational memory.

## The Problem We Solved

Before this system existed, conversation history was injected raw into the system prompt — the last 10 conversations, untruncated, with no token awareness. This caused two critical failures:

1. **Context overflow**: A Haiku agent (200K limit) hit 211K tokens and crashed with `prompt is too long`. Individual conversations contained massive tool outputs (sprint reports, full vault searches) that snowballed.
2. **Recursive nesting**: The channel gateway prepended conversation history into `input.text`, which got logged as a conversation, which then got loaded into the next request's history — exponential growth. A single message would nest `[Previous conversation in this thread]` inside itself repeatedly.

## Architecture

```
User Message
    │
    ▼
AgentService.process()
    │
    ├─ 1. Build systemPromptBase (agent prompt + date + language)
    ├─ 2. Build memoryContext (16KB cap, existing system)
    ├─ 3. ConversationContextService.buildHistoryContext()
    │       ├─ Compute token budget from model's context window
    │       ├─ Load 5 most recent conversations (per-entry truncation)
    │       ├─ Prepend compaction summary if available
    │       ├─ Enforce total budget — stop adding entries when full
    │       └─ Schedule async compaction if old conversations exist without summary
    ├─ 4. Assemble full systemPrompt (base + memory + history)
    └─ 5. Call query() — guaranteed to fit within model limit
```

**Key file**: `src/services/context-manager.ts`

## Token Budget Model

Every API call must fit within the model's context window. The context manager computes a **history budget** by subtracting all fixed costs:

```
contextWindow (model-dependent)
  - outputReservation:  16,000 tokens   (headroom for the agent's response)
  - toolsEstimate:       8,000 tokens   (MCP tool schema definitions)
  - safetyMargin:       10,000 tokens   (buffer for tool results during execution)
  - systemPromptBase:    ~2,000 tokens  (agent prompt + date + language directive)
  - memoryContext:        ~4,000 tokens  (memory system's own 16KB cap)
  ─────────────────────────────────────
  = historyBudget:     ~160,000 tokens  (for Haiku/Sonnet 200K window)
```

The budget is computed dynamically per request — if an agent has a large system prompt or many memories, the history budget shrinks accordingly.

### Model Context Windows

| Model | Context Window | Effective History Budget |
|-------|---------------|------------------------|
| `claude-haiku-4-5` | 200,000 | ~160,000 |
| `claude-sonnet-4-6` | 200,000 | ~160,000 |
| `claude-opus-4-6` | 200,000 | ~160,000 |
| Fallback (unknown) | 200,000 | ~160,000 |

Token estimation uses `Math.ceil(text.length / 4)` — the ~4 chars per token heuristic, which works well for English/Portuguese text.

## History Loading Strategy

### 1. Recent Conversations (Verbatim)

The 5 most recent conversations are loaded in chronological order with **per-entry truncation**:

| Field | Cap | Rationale |
|-------|-----|-----------|
| `input` | 2,000 chars | User messages are usually short; cap prevents injected history nesting |
| `output` | 6,000 chars | Agent responses can be long but the gist fits in 6K |

When truncated, the entry gets a marker: `... [truncated, N chars total]`

Entries are added until the token budget is exhausted — if 5 entries don't fit, fewer are included.

### 2. Compaction Summary (Prepended)

If a compaction summary exists for older conversations, it's prepended before the recent entries:

```
[Summary of earlier conversations (47 turns)]
 Discussed sprint W14-15 planning,
Web3Auth integration, wallet service deployment. Agent recommended
scheduling 1:1s with all 9 team members...

---

User: oi
Assistant: Oi! 👋 Como posso ajudar?

User: como tá minha sprint?
Assistant: A Sprint W14-15 está em andamento com 8 dev/days...
```

### 3. Fallback (No Summary, Many Old Conversations)

When old conversations exist but no summary has been generated yet, the system:
- Uses only the recent 5 (truncated) — guaranteed safe
- Schedules async compaction in the background (fire-and-forget)
- Next request will benefit from the summary

## Compaction

### When It Runs

Compaction is triggered asynchronously when:
- There are more than 5 conversations for an (agentId, source) pair
- No existing summary covers the older ones
- The circuit breaker hasn't tripped (< 3 consecutive failures)

### How It Works

1. Load up to 50 old conversations (before the recent 5)
2. If a previous summary exists, include it for merging
3. Send to Claude Haiku via direct API call (`ANTHROPIC_API_KEY` required)
4. Prompt asks for a structured summary covering:
   - Key decisions made
   - User preferences and communication style
   - Ongoing tasks or projects
   - Important facts and context
   - Errors or issues encountered
   - Pending action items
5. Store result in `conversation_summaries` table
6. Next request picks it up automatically

### Why Not `query()`?

The Claude Agent SDK's `query()` function spawns a full Claude Code subprocess. This is too heavy for a background summarization task and crashes under concurrency (the subprocess conflicts with the main agent's process). Compaction uses a direct `fetch()` to the Anthropic API instead.

**When no `ANTHROPIC_API_KEY` is set**: Compaction is skipped entirely. The system degrades gracefully to truncation-only mode — recent 5 conversations with per-entry caps.

### Circuit Breaker

After 3 consecutive compaction failures for an (agentId, source) pair, compaction stops retrying. This prevents infinite retry loops if the API is down or the compaction prompt itself is too large.

### Summary Stacking

Over time, summaries accumulate. When compacting, the previous summary is included in the compaction input, producing a merged summary. Only one active summary per (agentId, source) exists at a time (the one with the highest `covers_to_id`).

## Database Schema

### `conversations` Table (Existing)

Stores raw conversation turns. Each entry has `input`, `output`, `source`, `agent_id`, `timestamp`.

**Important**: Error responses (`"Error processing request. Please try again."` and `"Agent execution timed out."`) are NOT logged to prevent history pollution. This was a critical fix — previously, error responses were logged and then included in the next request's history, compounding failures.

### `conversation_summaries` Table (New)

```sql
CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  source TEXT NOT NULL,
  summary TEXT NOT NULL,
  covers_from_id INTEGER NOT NULL,   -- oldest conversation.id covered
  covers_to_id INTEGER NOT NULL,     -- newest conversation.id covered
  conversation_count INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(agent_id, source, covers_to_id)
);
```

**Migration**: `src/migrations/014_conversation_compaction.sql`

## History Isolation

History is scoped by **(agentId, source)**. This means:

- Telegram conversations don't leak into web chat history
- Each agent has its own history — the Hathor Specialist doesn't see the CTO Agent's conversations
- Summaries are also scoped — each agent/source pair has its own compaction

## Decisions and Tradeoffs

### Why 5 Recent Conversations (Not 10)?

The old system loaded 10 raw conversations. With per-entry truncation caps (2K input + 6K output = 8K chars ≈ 2K tokens each), 5 entries use ~10K tokens — leaving massive headroom for the summary and safety margin. 10 entries with no truncation could easily hit 100K+ tokens from a single sprint report response.

### Why Per-Entry Truncation Instead of Global Truncation?

Global truncation (cap total history at N tokens) would cut off mid-conversation. Per-entry truncation preserves the structure of each conversation while preventing any single massive response from dominating the context.

### Why Store Summaries in DB Instead of Generating On-The-Fly?

On-the-fly summarization would add latency to every request (LLM call before the agent can respond). Storing summaries means the cost is paid once, asynchronously, and every subsequent request benefits instantly.

### Why Direct API Instead of Agent SDK for Compaction?

The Claude Agent SDK `query()` spawns a Claude Code subprocess per call. Running this concurrently with the agent's own `query()` call caused `exit code 1` crashes. Direct `fetch()` to the API is lightweight and doesn't interfere with the agent runtime.

### Why Not Compact the Gateway's History?

The channel gateway (`src/channels/gateway.ts`) deliberately does NOT inject conversation history. It passes only the raw user message to the orchestrator. History injection is the sole responsibility of `AgentService.process()` via the context manager. This prevents the recursive nesting bug where history-in-input gets logged then re-loaded.

## Message Deduplication (Telegram)

Rapid messages from the same user in the same thread are debounced:

1. First message starts a **1.5-second timer**
2. Subsequent messages reset the timer and append to a batch
3. After 1.5s of silence, all messages merge into one (`text: "msg1\nmsg2\nmsg3"`)
4. A **per-thread lock** prevents concurrent processing — if the agent is still responding, new messages queue up for the next batch

This prevents the scenario where sending "oi" three times produces three separate agent responses.

**Key file**: `src/channels/gateway.ts` (debounce + thread lock in `handleInbound` / `processBatch`)

## Memory System Integration

The memory system (`src/services/memory-service.ts`) is separate from conversation history but shares the context budget:

- **Memory context**: Injected into system prompt with a 16KB hard cap
- **Memory tools**: Agents have MCP tools (`remember`, `recall`, `forget`, `list_memories`) to actively manage memories
- **Memory instructions**: System prompt tells agents to proactively save important facts using the `remember` tool after each conversation
- **No auto-extraction subprocess**: The original design used a separate LLM call for auto-extraction, but this conflicted with the Agent SDK's subprocess model. Instead, agents save memories directly via MCP tools during their normal turn.

## Configuration Constants

All defined in `src/services/context-manager.ts`:

| Constant | Value | Purpose |
|----------|-------|---------|
| `RECENT_CONVERSATIONS_VERBATIM` | 5 | Recent conversations loaded without summarization |
| `MAX_ENTRY_INPUT_CHARS` | 2,000 | Per-conversation input truncation cap |
| `MAX_ENTRY_OUTPUT_CHARS` | 6,000 | Per-conversation output truncation cap |
| `OUTPUT_RESERVATION_TOKENS` | 16,000 | Reserved for model response generation |
| `TOOLS_ESTIMATE_TOKENS` | 8,000 | Estimated MCP tool schema overhead |
| `SAFETY_MARGIN_TOKENS` | 10,000 | Buffer for in-flight tool results |
| `MAX_SUMMARY_TOKENS` | 4,000 | Cap on compaction summary size |
| `COMPACTION_CIRCUIT_BREAKER` | 3 | Max consecutive failures before giving up |

## Logging

The context manager logs its decisions on every request:

```
[context-manager] History: 5 recent entries + summary (~4521 tokens, budget: 165755)
[context-manager] History: 3 recent entries + no summary (~1200 tokens, budget: 165755)
[context-manager] Compacted 20 conversations into summary (~890 tokens)
[context-manager] No ANTHROPIC_API_KEY — skipping compaction.
```

## Related Documentation

- [Agent System](./02-agent-system.md) — Agent configuration, orchestrator, memory system
- [Database & Persistence](./05-database-and-persistence.md) — Full schema reference including `conversations` and `conversation_summaries` tables
- [Integrations](./08-integrations.md) — Channel adapters, Telegram deduplication
- [Runtime & Execution](./09-runtime-and-execution.md) — Agent runtime, Agent OS, in-process execution
