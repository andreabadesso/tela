import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { DatabaseService } from '../core/database.js';
import type { AgentMemoryRow } from '../types/index.js';
import { config } from '../config/env.js';

const MAX_MEMORY_CONTEXT_BYTES = 16_000; // ~4000 tokens

/**
 * Build formatted memory context string for injection into the system prompt.
 */
export function buildMemoryContext(db: DatabaseService, agentId: string, userId?: string): string {
  if (!config.agentMemoryEnabled) return '';

  const sections: string[] = [];

  // Global memories (cap 50)
  const globalMemories = db.getMemories(agentId, { scope: 'global', limit: 50 });
  if (globalMemories.length > 0) {
    sections.push('## Global Memories');
    for (const m of globalMemories) {
      const staleWarning = getStaleWarning(m);
      sections.push(`- **${m.name}** [${m.type}]: ${m.description}${staleWarning}`);
    }
  }

  // User-specific memories (cap 30)
  if (userId) {
    const userMemories = db.getMemories(agentId, { userId, scope: 'user', limit: 30 });
    if (userMemories.length > 0) {
      sections.push('## User-Specific Memories');
      for (const m of userMemories) {
        const staleWarning = getStaleWarning(m);
        sections.push(`- **${m.name}** [${m.type}]: ${m.description}${staleWarning}`);
      }
    }

    // User behavior config
    const behaviorConfig = db.getBehaviorConfig(agentId, userId);
    if (behaviorConfig) {
      try {
        const cfg = JSON.parse(behaviorConfig.config);
        const parts: string[] = [];
        if (cfg.tone) parts.push(`Tone: ${cfg.tone}`);
        if (cfg.language) parts.push(`Language: ${cfg.language}`);
        if (cfg.verbosity) parts.push(`Verbosity: ${cfg.verbosity}`);
        if (cfg.name_to_call_user) parts.push(`Call user: ${cfg.name_to_call_user}`);
        if (cfg.topics_to_avoid?.length) parts.push(`Avoid topics: ${cfg.topics_to_avoid.join(', ')}`);
        if (cfg.custom_instructions) parts.push(`Custom instructions: ${cfg.custom_instructions}`);
        if (parts.length > 0) {
          sections.push('## User Preferences');
          sections.push(parts.join('\n'));
        }
      } catch { /* ignore malformed config */ }
    }
  }

  // Always include memory instructions when memory is enabled
  sections.push(`## Memory Instructions
You have memory tools available: \`remember\`, \`recall\`, \`forget\`, \`list_memories\`.
After responding to the user, silently save any new persistent facts worth remembering using the \`remember\` tool. Save things like:
- User facts: role, expertise, preferences, name
- Feedback: corrections about your behavior, confirmed approaches
- Project: goals, deadlines, decisions, incidents
- References: external systems, URLs, tools mentioned
Do NOT save: code patterns, ephemeral task details, things already in your memories above, or trivial greetings.
Only save genuinely new information. Do not mention to the user that you are saving memories.`);

  let context = `\n=== MEMORY CONTEXT ===\n${sections.join('\n')}\n=== END MEMORY CONTEXT ===\n`;

  // Truncate if exceeding limit
  if (Buffer.byteLength(context, 'utf-8') > MAX_MEMORY_CONTEXT_BYTES) {
    context = context.slice(0, MAX_MEMORY_CONTEXT_BYTES - 50) + '\n... (memories truncated)\n=== END MEMORY CONTEXT ===\n';
  }

  return context;
}

function getStaleWarning(m: AgentMemoryRow): string {
  if (!m.stale_after_days) return '';
  const updatedAt = new Date(m.updated_at).getTime();
  const now = Date.now();
  const daysSinceUpdate = (now - updatedAt) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate > m.stale_after_days) {
    return ` ⚠️ STALE (${Math.floor(daysSinceUpdate)} days old)`;
  }
  return '';
}

/**
 * Build an MCP server with memory tools for the agent.
 * agentId and userId are captured via closure from the current request context.
 */
export function buildMemoryMcpServer(db: DatabaseService, agentId: string, userId?: string) {
  const tools = [
    tool('remember', 'Save a memory for later recall. Use this to remember important facts, user preferences, project details, or feedback.', {
      content: z.string().describe('The memory content to save'),
      type: z.enum(['user', 'feedback', 'project', 'reference', 'preference']).describe('Memory type'),
      name: z.string().describe('Short title for the memory'),
      description: z.string().optional().describe('One-line summary (defaults to truncated content)'),
      scope: z.enum(['global', 'user']).optional().describe('global = shared, user = per-user (default: global)'),
    }, async (args) => {
      const scope = args.scope ?? 'global';
      // Dedup: if a memory with the same agent+name exists, update it
      const existing = db.getMemories(agentId, { userId: scope === 'user' ? userId : undefined })
        .find(m => m.name === args.name);
      if (existing) {
        const updated = db.updateMemory(existing.id, {
          content: args.content,
          description: args.description ?? args.content.slice(0, 100),
          type: args.type,
        });
        return { content: [{ type: 'text' as const, text: `Memory updated: ${updated?.id}` }] };
      }
      const memory = db.createMemory({
        agent_id: agentId,
        user_id: scope === 'user' ? userId ?? null : null,
        scope,
        type: args.type,
        name: args.name,
        description: args.description ?? args.content.slice(0, 100),
        content: args.content,
        source: 'tool',
      });
      return { content: [{ type: 'text' as const, text: `Memory saved: ${memory.id}` }] };
    }),

    tool('recall', 'Search memories by text query. Returns matching memories sorted by relevance.', {
      query: z.string().describe('Search query'),
      scope: z.enum(['global', 'user', 'all']).optional().describe('Filter by scope (default: all)'),
      type: z.string().optional().describe('Filter by memory type'),
      limit: z.number().optional().describe('Max results (default: 10)'),
    }, async (args) => {
      const scopeFilter = args.scope === 'all' ? undefined : args.scope;
      const results = db.searchMemories(agentId, args.query, {
        userId: args.scope === 'user' ? userId : undefined,
        scope: scopeFilter,
        limit: args.limit ?? 10,
      });
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No memories found matching that query.' }] };
      }
      const formatted = results.map(m =>
        `[${m.id}] ${m.name} (${m.type}, ${m.scope}): ${m.description}\n${m.content}`
      ).join('\n\n---\n\n');
      return { content: [{ type: 'text' as const, text: formatted }] };
    }),

    tool('forget', 'Delete a specific memory by ID.', {
      memoryId: z.string().describe('The memory ID to delete'),
    }, async (args) => {
      const deleted = db.deleteMemory(args.memoryId);
      return {
        content: [{ type: 'text' as const, text: deleted ? 'Memory deleted.' : 'Memory not found.' }],
      };
    }),

    tool('list_memories', 'List all memories, optionally filtered by scope or type.', {
      scope: z.enum(['global', 'user', 'all']).optional().describe('Filter by scope'),
      type: z.string().optional().describe('Filter by memory type'),
    }, async (args) => {
      const opts: { userId?: string; scope?: string; type?: string } = {};
      if (args.scope === 'user' && userId) opts.userId = userId;
      if (args.scope && args.scope !== 'all') opts.scope = args.scope;
      if (args.type) opts.type = args.type;
      const memories = db.getMemories(agentId, opts);
      if (memories.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
      }
      const list = memories.map(m =>
        `[${m.id}] ${m.name} (${m.type}, ${m.scope}) — ${m.description}`
      ).join('\n');
      return { content: [{ type: 'text' as const, text: `${memories.length} memories:\n${list}` }] };
    }),

    tool('get_user_context', 'Get the current user\'s preferences, behavior config, and recent memory summary.', {}, async () => {
      if (!userId) {
        return { content: [{ type: 'text' as const, text: 'No user context available (anonymous session).' }] };
      }
      const parts: string[] = [];

      // User memories
      const userMemories = db.getMemories(agentId, { userId, scope: 'user', limit: 20 });
      if (userMemories.length > 0) {
        parts.push('## User Memories');
        parts.push(userMemories.map(m => `- ${m.name}: ${m.description}`).join('\n'));
      }

      // Behavior config
      const behaviorConfig = db.getBehaviorConfig(agentId, userId);
      if (behaviorConfig) {
        parts.push('## Behavior Config');
        parts.push(behaviorConfig.config);
      }

      return {
        content: [{ type: 'text' as const, text: parts.length > 0 ? parts.join('\n\n') : 'No user context stored yet.' }],
      };
    }),
  ];

  return createSdkMcpServer({
    name: 'memory-tools',
    version: '1.0.0',
    tools,
  });
}
