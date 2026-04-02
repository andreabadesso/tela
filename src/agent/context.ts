import type { DatabaseService } from '../core/database.js';
import type { ConversationRow } from '../types/index.js';

// ─── Constants ──────────────────────────────────────────────────

const RECENT_CONVERSATIONS_VERBATIM = 5;
const MAX_ENTRY_INPUT_CHARS = 2_000;
const MAX_ENTRY_OUTPUT_CHARS = 6_000;
const OUTPUT_RESERVATION_TOKENS = 16_000;
const TOOLS_ESTIMATE_TOKENS = 8_000;
const SAFETY_MARGIN_TOKENS = 10_000;
const MAX_SUMMARY_TOKENS = 4_000;
const COMPACTION_CIRCUIT_BREAKER = 3;

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-haiku-4-5': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-3-5': 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 200_000;

// ─── Service ────────────────────────────────────────────────────

export class ConversationContextService {
  private compactionFailures = new Map<string, number>();

  constructor(private db: DatabaseService) {}

  /**
   * Estimate tokens from text. ~4 chars per token for English/Portuguese mix.
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Get model's context window size.
   */
  getModelContextWindow(model: string): number {
    // Try exact match first, then prefix match
    if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
    for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
      if (model.startsWith(key)) return value;
    }
    return DEFAULT_CONTEXT_WINDOW;
  }

  /**
   * Main entry point: build the history context string within token budget.
   */
  buildHistoryContext(opts: {
    agentId: string;
    source: string;
    model: string;
    systemPromptBaseTokens: number;
    memoryContextTokens: number;
  }): string {
    const contextWindow = this.getModelContextWindow(opts.model);
    const historyBudget = contextWindow
      - OUTPUT_RESERVATION_TOKENS
      - TOOLS_ESTIMATE_TOKENS
      - SAFETY_MARGIN_TOKENS
      - opts.systemPromptBaseTokens
      - opts.memoryContextTokens;

    if (historyBudget <= 0) {
      console.warn(`[context-manager] No budget for history (budget=${historyBudget}). Skipping.`);
      return '';
    }

    // 1. Load recent conversations (most recent first from DB)
    const recent = this.db.getRecentConversations(opts.source, RECENT_CONVERSATIONS_VERBATIM, opts.agentId);
    if (recent.length === 0) return '';

    // Reverse to chronological order
    const chronological = recent.reverse();

    // 2. Truncate each entry and build formatted strings
    const formattedEntries: string[] = [];
    let usedTokens = 0;

    for (const conv of chronological) {
      const entry = this.truncateEntry(conv);
      const entryTokens = this.estimateTokens(entry);

      if (usedTokens + entryTokens > historyBudget) break;
      formattedEntries.push(entry);
      usedTokens += entryTokens;
    }

    // 3. Try to prepend a compaction summary of older conversations
    const oldestRecentId = recent[recent.length - 1]?.id; // oldest of the recent batch (highest id since reversed)
    // Actually recent is DESC from DB, so recent[0] is newest, recent[recent.length-1] is oldest
    const oldestId = recent[recent.length - 1]?.id;

    let summarySection = '';
    if (oldestId) {
      const summary = this.db.getActiveSummary(opts.agentId, opts.source);
      if (summary && summary.covers_to_id < oldestId) {
        const summaryTokens = this.estimateTokens(summary.summary);
        if (usedTokens + summaryTokens <= historyBudget) {
          summarySection = `[Summary of earlier conversations (${summary.conversation_count} turns)]\n${summary.summary}\n\n---\n\n`;
          usedTokens += summaryTokens;
        }
      } else if (!summary) {
        // No summary exists — schedule async compaction if there are older conversations
        const totalCount = this.db.getConversationCountForAgent(opts.agentId, opts.source);
        if (totalCount > RECENT_CONVERSATIONS_VERBATIM) {
          this.scheduleCompaction(opts.agentId, opts.source, oldestId);
        }
      }
    }

    if (formattedEntries.length === 0 && !summarySection) return '';

    const historyBlock = formattedEntries.join('\n\n');
    const estimatedTotal = this.estimateTokens(summarySection + historyBlock);
    console.log(`[context-manager] History: ${formattedEntries.length} recent entries + ${summarySection ? 'summary' : 'no summary'} (~${estimatedTotal} tokens, budget: ${historyBudget})`);

    return `Recent conversation history:\n${summarySection}${historyBlock}`;
  }

  /**
   * Truncate a single conversation entry to fit per-entry caps.
   */
  private truncateEntry(conv: ConversationRow): string {
    let input = conv.input;
    let output = conv.output;

    if (input.length > MAX_ENTRY_INPUT_CHARS) {
      input = input.slice(0, MAX_ENTRY_INPUT_CHARS) + `... [truncated, ${input.length} chars total]`;
    }

    if (output.length > MAX_ENTRY_OUTPUT_CHARS) {
      output = output.slice(0, MAX_ENTRY_OUTPUT_CHARS) + `... [truncated, ${output.length} chars total]`;
    }

    return `User: ${input}\nAssistant: ${output}`;
  }

  /**
   * Schedule async compaction (fire-and-forget).
   */
  private scheduleCompaction(agentId: string, source: string, beforeId: number): void {
    const key = `${agentId}:${source}`;
    const failures = this.compactionFailures.get(key) ?? 0;
    if (failures >= COMPACTION_CIRCUIT_BREAKER) return;

    // Fire-and-forget
    this.compactOldConversations(agentId, source, beforeId).catch(err => {
      console.error('[context-manager] Compaction failed:', err);
      this.compactionFailures.set(key, failures + 1);
    });
  }

  /**
   * Compact old conversations into a summary.
   */
  async compactOldConversations(agentId: string, source: string, beforeId: number): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log('[context-manager] No ANTHROPIC_API_KEY — skipping compaction.');
      return;
    }

    const oldConversations = this.db.getConversationsOlderThan(agentId, source, beforeId, 50);
    if (oldConversations.length === 0) return;

    // Include existing summary if any (merge into new one)
    const existingSummary = this.db.getActiveSummary(agentId, source);
    const existingContext = existingSummary
      ? `Previous summary (covering ${existingSummary.conversation_count} earlier conversations):\n${existingSummary.summary}\n\n---\n\n`
      : '';

    // Build conversation text for summarization (truncated)
    const conversationText = oldConversations
      .reverse() // chronological
      .map(c => {
        const input = c.input.length > 1000 ? c.input.slice(0, 1000) + '...' : c.input;
        const output = c.output.length > 2000 ? c.output.slice(0, 2000) + '...' : c.output;
        return `User: ${input}\nAssistant: ${output}`;
      })
      .join('\n\n');

    const prompt = `Summarize this conversation history into a concise context summary for an AI agent. Focus on:
1. Key decisions made
2. User preferences and communication style
3. Ongoing tasks or projects discussed
4. Important facts and context
5. Errors or issues encountered
6. Pending action items

${existingContext}Recent conversations to summarize:
${conversationText}

Write a dense, factual summary (max 1000 words). No preamble, just the summary.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20241022',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Compaction API error: ${response.status}`);
    }

    const data = await response.json() as { content: Array<{ type: string; text?: string }> };
    const summaryText = data.content?.[0]?.text?.trim();
    if (!summaryText) throw new Error('Empty compaction response');

    const coversFromId = oldConversations[oldConversations.length - 1].id; // oldest
    const coversToId = oldConversations[0].id; // newest (before reverse)
    const totalCount = oldConversations.length + (existingSummary?.conversation_count ?? 0);

    this.db.createConversationSummary({
      agent_id: agentId,
      source,
      summary: summaryText,
      covers_from_id: Math.min(existingSummary?.covers_from_id ?? coversFromId, coversFromId),
      covers_to_id: coversToId,
      conversation_count: totalCount,
      estimated_tokens: this.estimateTokens(summaryText),
    });

    console.log(`[context-manager] Compacted ${oldConversations.length} conversations into summary (~${this.estimateTokens(summaryText)} tokens)`);
  }
}
