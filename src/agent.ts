import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { createVaultTools } from './tools/vault.js';
import type { TelegramService } from './services/telegram.js';
import type { GitSync } from './services/git.js';
import type { DatabaseService } from './services/database.js';
import type { AgentInput, AgentOutput } from './types/index.js';
import { config } from './config/env.js';
import { z } from 'zod';

type VaultTools = ReturnType<typeof createVaultTools>;

export class CtoAgent {
  private mcpServer;

  constructor(
    private vault: VaultTools,
    private telegram: TelegramService,
    private gitSync: GitSync,
    private db: DatabaseService,
  ) {
    this.mcpServer = this.buildMcpServer();
  }

  private buildMcpServer() {
    const v = this.vault;

    const tools = [
      tool('read_note', 'Read a note from the vault by relative path.', {
        path: z.string().describe('Relative path to the note'),
      }, async (args) => ({
        content: [{ type: 'text' as const, text: await v.read_note(args.path) }],
      })),

      tool('write_note', 'Create or overwrite a note. Creates parent directories.', {
        path: z.string().describe('Relative path to the note'),
        content: z.string().describe('Content to write'),
      }, async (args) => ({
        content: [{ type: 'text' as const, text: await v.write_note(args.path, args.content) }],
      })),

      tool('edit_note', 'Find and replace a string within a note.', {
        path: z.string().describe('Relative path to the note'),
        oldString: z.string().describe('String to find'),
        newString: z.string().describe('Replacement string'),
      }, async (args) => ({
        content: [{ type: 'text' as const, text: await v.edit_note(args.path, args.oldString, args.newString) }],
      })),

      tool('append_to_note', 'Append text to the end of a note.', {
        path: z.string().describe('Relative path to the note'),
        content: z.string().describe('Text to append'),
      }, async (args) => ({
        content: [{ type: 'text' as const, text: await v.append_to_note(args.path, args.content) }],
      })),

      tool('prepend_to_note', 'Insert text at the top of a note (after frontmatter).', {
        path: z.string().describe('Relative path to the note'),
        content: z.string().describe('Text to prepend'),
      }, async (args) => ({
        content: [{ type: 'text' as const, text: await v.prepend_to_note(args.path, args.content) }],
      })),

      tool('search_vault', 'Full-text search across the vault.', {
        query: z.string().describe('Search query'),
        path: z.string().optional().describe('Subdirectory to search within'),
        maxResults: z.number().optional().describe('Max results (default 20)'),
      }, async (args) => {
        const results = await v.search_vault(args.query, {
          path: args.path,
          maxResults: args.maxResults,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      }),

      tool('list_notes', 'List markdown files in a vault directory.', {
        dir: z.string().optional().describe('Subdirectory (default: vault root)'),
        recursive: z.boolean().optional().describe('Recurse into subdirectories'),
      }, async (args) => {
        const files = await v.list_notes(args.dir, { recursive: args.recursive });
        return { content: [{ type: 'text' as const, text: files.join('\n') }] };
      }),

      tool('get_tasks', 'Parse task items (- [ ], - [x], - [>]) across the vault.', {
        path: z.string().optional().describe('Subdirectory to search'),
        includeCompleted: z.boolean().optional().describe('Include completed tasks'),
      }, async (args) => {
        const tasks = await v.get_tasks({
          path: args.path,
          includeCompleted: args.includeCompleted,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(tasks, null, 2) }] };
      }),

      tool('get_daily_note', 'Read today\'s daily note. Creates from template if missing.', {
        date: z.string().optional().describe('Date in YYYY-MM-DD format'),
      }, async (args) => ({
        content: [{ type: 'text' as const, text: await v.get_daily_note(args.date) }],
      })),
    ];

    return createSdkMcpServer({
      name: 'vault-tools',
      version: '1.0.0',
      tools,
    });
  }

  private getExternalMcpServers(): Record<string, { type: 'sse'; url: string; headers?: Record<string, string> }> {
    const servers: Record<string, { type: 'sse'; url: string; headers?: Record<string, string> }> = {};

    if (config.shiplensUrl && config.shiplensApiKey) {
      servers['shiplens'] = {
        type: 'sse',
        url: config.shiplensUrl,
        headers: { Authorization: `Bearer ${config.shiplensApiKey}` },
      };
    }

    return servers;
  }

  async process(input: AgentInput, systemPromptAddition?: string): Promise<AgentOutput> {
    const startTime = Date.now();
    console.log(`[agent] Processing: "${input.text.slice(0, 100)}" (source: ${input.source})`);

    // Pull latest vault changes before processing
    await this.gitSync.pull();

    // Build context from recent history
    const recentHistory = this.db
      .getRecentConversations(input.source, 10)
      .reverse()
      .map((c) => `User: ${c.input}\nAssistant: ${c.output}`)
      .join('\n\n');

    const today = new Date().toLocaleDateString('pt-BR', {
      timeZone: config.timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const systemPrompt = [
      'You are an AI assistant with access to the user\'s knowledge base via vault tools (read, write, search, list).',
      `Today is ${today}.`,
      'Respond in Portuguese (BR) unless the message is in English.',
      'Be concise and direct — the user is technical.',
      'IMPORTANT: You are replying via Telegram which ONLY supports HTML formatting. Use <b>bold</b>, <i>italic</i>, <code>inline code</code>, <pre>code blocks</pre>. NEVER use markdown syntax: no **, no *, no `, no ```, no #, no tables, no [links](url). Use • for bullet lists. Use <a href="url">text</a> for links.',
      'When updating the vault, use the vault tools provided.',
      '',
      recentHistory ? `Recent conversation history:\n${recentHistory}` : '',
      systemPromptAddition || '',
    ].filter(Boolean).join('\n');

    let resultText = '';

    try {
      for await (const message of query({
        prompt: input.text,
        options: {
          systemPrompt,
          model: 'claude-sonnet-4-6',
          maxTurns: 15,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          mcpServers: {
            'vault-tools': this.mcpServer,
            ...this.getExternalMcpServers(),
          },
        },
      })) {
        console.log(`[agent] Message type: ${JSON.stringify(Object.keys(message))}`);
        if ('result' in message) {
          resultText = message.result ?? '';
        }
      }
      console.log(`[agent] Response (${resultText.length} chars): "${resultText.slice(0, 200)}"`);
    } catch (err) {
      console.error('[agent] Claude API error:', err);
      // Retry once without MCP tools
      try {
        for await (const message of query({
          prompt: input.text,
          options: {
            systemPrompt,
            model: 'claude-sonnet-4-6',
            maxTurns: 10,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
          },
        })) {
          if ('result' in message) {
            resultText = message.result ?? '';
          }
        }
      } catch (retryErr) {
        console.error('[agent] Retry failed:', retryErr);
        resultText = '⚠️ Desculpa, tive um erro ao processar. Tenta de novo em alguns minutos.';
      }
    }

    // Flush any vault writes
    await this.gitSync.flush();

    const durationMs = Date.now() - startTime;

    // Log conversation
    this.db.logConversation({
      source: input.source,
      input: input.text,
      output: resultText,
      durationMs,
    });

    return { text: resultText };
  }
}
