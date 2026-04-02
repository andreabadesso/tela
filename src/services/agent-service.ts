import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { createVaultTools } from '../tools/vault.js';
import type { GitSync } from './git.js';
import type { DatabaseService } from './database.js';
import type { McpGateway } from './mcp-gateway.js';
import type { KnowledgeManager } from '../knowledge/manager.js';
import type { AgentInput, AgentOutput } from '../types/index.js';
import { config } from '../config/env.js';
import { buildMemoryContext, buildMemoryMcpServer } from './memory-service.js';
import { ConversationContextService } from './context-manager.js';
import type { ToolSandbox } from '../types/runtime.js';

type VaultTools = ReturnType<typeof createVaultTools>;

export class AgentService {
  private mcpServer;
  private mcpGateway: McpGateway | null;
  private knowledgeManager: KnowledgeManager | null;

  constructor(
    private db: DatabaseService,
    private vault: VaultTools,
    private gitSync: GitSync,
    mcpGateway?: McpGateway,
    knowledgeManager?: KnowledgeManager,
  ) {
    this.mcpServer = this.buildMcpServer();
    this.mcpGateway = mcpGateway ?? null;
    this.knowledgeManager = knowledgeManager ?? null;
  }

  private buildMcpServer(sandbox?: ToolSandbox) {
    const v = this.vault;

    // When a sandbox is provided, file read/write operations run inside
    // the sandbox VM (Agent OS V8 isolate or Docker container) instead
    // of directly on the host filesystem.
    const readNote = sandbox
      ? async (path: string) => {
          const bytes = await sandbox.readFile(path);
          return new TextDecoder().decode(bytes);
        }
      : (path: string) => v.read_note(path);

    const writeNote = sandbox
      ? async (path: string, content: string) => {
          await sandbox.writeFile(path, new TextEncoder().encode(content));
          return `Written: ${path}`;
        }
      : (path: string, content: string) => v.write_note(path, content);

    const searchVault = sandbox
      ? async (query: string, opts?: { path?: string; maxResults?: number }) => {
          // Search via sandbox grep command
          const maxResults = opts?.maxResults ?? 20;
          const searchPath = opts?.path ?? '.';
          const result = await sandbox.runCommand(
            `grep -rl --include='*.md' ${JSON.stringify(query)} ${JSON.stringify(searchPath)} | head -${maxResults}`
          );
          return result.stdout.split('\n').filter(Boolean).map(f => ({ file: f, content: '', line: 0, context: [] }));
        }
      : (query: string, opts?: { path?: string; maxResults?: number }) => v.search_vault(query, opts);

    const listNotes = sandbox
      ? async (dir?: string, opts?: { recursive?: boolean }) => {
          const searchDir = dir ?? '.';
          const cmd = opts?.recursive
            ? `find ${JSON.stringify(searchDir)} -name '*.md' -type f`
            : `ls ${JSON.stringify(searchDir)}/*.md 2>/dev/null`;
          const result = await sandbox.runCommand(cmd);
          return result.stdout.split('\n').filter(Boolean);
        }
      : (dir?: string, opts?: { recursive?: boolean }) => v.list_notes(dir, opts);

    const tools = [
      tool('read_note', 'Read a note from the vault by relative path.', {
        path: z.string().describe('Relative path to the note'),
      }, async (args) => ({
        content: [{ type: 'text' as const, text: await readNote(args.path) }],
      })),

      tool('write_note', 'Create or overwrite a note. Creates parent directories.', {
        path: z.string().describe('Relative path to the note'),
        content: z.string().describe('Content to write'),
      }, async (args) => ({
        content: [{ type: 'text' as const, text: await writeNote(args.path, args.content) }],
      })),

      tool('edit_note', 'Find and replace a string within a note.', {
        path: z.string().describe('Relative path to the note'),
        oldString: z.string().describe('String to find'),
        newString: z.string().describe('Replacement string'),
      }, async (args) => {
        if (sandbox) {
          const bytes = await sandbox.readFile(args.path);
          const content = new TextDecoder().decode(bytes);
          const updated = content.replace(args.oldString, args.newString);
          await sandbox.writeFile(args.path, new TextEncoder().encode(updated));
          return { content: [{ type: 'text' as const, text: `Edited: ${args.path}` }] };
        }
        return { content: [{ type: 'text' as const, text: await v.edit_note(args.path, args.oldString, args.newString) }] };
      }),

      tool('append_to_note', 'Append text to the end of a note.', {
        path: z.string().describe('Relative path to the note'),
        content: z.string().describe('Text to append'),
      }, async (args) => {
        if (sandbox) {
          const bytes = await sandbox.readFile(args.path);
          const existing = new TextDecoder().decode(bytes);
          await sandbox.writeFile(args.path, new TextEncoder().encode(existing + '\n' + args.content));
          return { content: [{ type: 'text' as const, text: `Appended to: ${args.path}` }] };
        }
        return { content: [{ type: 'text' as const, text: await v.append_to_note(args.path, args.content) }] };
      }),

      tool('prepend_to_note', 'Insert text at the top of a note (after frontmatter).', {
        path: z.string().describe('Relative path to the note'),
        content: z.string().describe('Text to prepend'),
      }, async (args) => {
        if (sandbox) {
          const bytes = await sandbox.readFile(args.path);
          const existing = new TextDecoder().decode(bytes);
          await sandbox.writeFile(args.path, new TextEncoder().encode(args.content + '\n' + existing));
          return { content: [{ type: 'text' as const, text: `Prepended to: ${args.path}` }] };
        }
        return { content: [{ type: 'text' as const, text: await v.prepend_to_note(args.path, args.content) }] };
      }),

      tool('search_vault', 'Full-text search across the vault.', {
        query: z.string().describe('Search query'),
        path: z.string().optional().describe('Subdirectory to search within'),
        maxResults: z.number().optional().describe('Max results (default 20)'),
      }, async (args) => {
        const results = await searchVault(args.query, {
          path: args.path,
          maxResults: args.maxResults,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      }),

      tool('list_notes', 'List markdown files in a vault directory.', {
        dir: z.string().optional().describe('Subdirectory (default: vault root)'),
        recursive: z.boolean().optional().describe('Recurse into subdirectories'),
      }, async (args) => {
        const files = await listNotes(args.dir, { recursive: args.recursive });
        return { content: [{ type: 'text' as const, text: files.join('\n') }] };
      }),

      tool('get_tasks', 'Parse task items (- [ ], - [x], - [>]) across the vault.', {
        path: z.string().optional().describe('Subdirectory to search'),
        includeCompleted: z.boolean().optional().describe('Include completed tasks'),
      }, async (args) => {
        // Tasks always run on host (need vault parsing logic)
        const tasks = await v.get_tasks({
          path: args.path,
          includeCompleted: args.includeCompleted,
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(tasks, null, 2) }] };
      }),

      tool('get_daily_note', 'Read today\'s daily note. Creates from template if missing.', {
        date: z.string().optional().describe('Date in YYYY-MM-DD format'),
      }, async (args) => ({
        // Daily note always runs on host (needs template logic)
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

  private buildKnowledgeMcpServer(adapter: { id: string; search: (q: string, o?: { maxResults?: number }) => Promise<any[]>; read: (p: string) => Promise<any>; list: (d?: string, o?: { recursive?: boolean }) => Promise<string[]> }, sourceName: string) {
    return createSdkMcpServer({
      name: `knowledge-${adapter.id}`,
      version: '1.0.0',
      tools: [
        tool(`search_${sourceName.toLowerCase().replace(/\s+/g, '_')}`, `Search the "${sourceName}" knowledge base for relevant notes.`, {
          query: z.string().describe('Search query'),
          maxResults: z.number().optional().describe('Max results (default 10)'),
        }, async (args) => {
          const results = await adapter.search(args.query, { maxResults: args.maxResults ?? 10 });
          return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
        }),

        tool(`read_${sourceName.toLowerCase().replace(/\s+/g, '_')}`, `Read a specific note from the "${sourceName}" knowledge base by path.`, {
          path: z.string().describe('Relative path to the note (e.g., "Sprints Planning/2026/Sprint 3.md")'),
        }, async (args) => {
          const doc = await adapter.read(args.path);
          return { content: [{ type: 'text' as const, text: typeof doc === 'string' ? doc : doc.content ?? JSON.stringify(doc) }] };
        }),

        tool(`list_${sourceName.toLowerCase().replace(/\s+/g, '_')}`, `List files in the "${sourceName}" knowledge base.`, {
          directory: z.string().optional().describe('Subdirectory to list (optional)'),
        }, async (args) => {
          const files = await adapter.list(args.directory, { recursive: true });
          return { content: [{ type: 'text' as const, text: files.join('\n') }] };
        }),
      ],
    });
  }

  private interpolatePrompt(template: string, agentName: string): string {
    const companyName = this.db.getSetting('company_name') ?? 'Company';
    const today = new Date().toLocaleDateString('pt-BR', {
      timeZone: config.timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    return template
      .replace(/\{\{company_name\}\}/g, companyName)
      .replace(/\{\{today\}\}/g, today)
      .replace(/\{\{agent_name\}\}/g, agentName);
  }

  async process(agentId: string, input: AgentInput, sandbox?: ToolSandbox): Promise<AgentOutput> {
    const startTime = Date.now();
    const agentConfig = this.db.getAgent(agentId);
    if (!agentConfig) throw new Error(`Agent not found: ${agentId}`);
    if (!agentConfig.enabled) throw new Error(`Agent is disabled: ${agentId}`);

    console.log(`[agent-service] Processing with agent "${agentConfig.name}" (${agentId}): "${input.text.slice(0, 100)}" (source: ${input.source})`);

    // Pull latest vault changes before processing
    await this.gitSync.pull();

    const today = new Date().toLocaleDateString('pt-BR', {
      timeZone: config.timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const interpolatedPrompt = this.interpolatePrompt(agentConfig.system_prompt, agentConfig.name);

    // Build memory context
    const memoryContext = buildMemoryContext(this.db, agentId, input.userId);

    // Build history context with token budget awareness
    const contextManager = new ConversationContextService(this.db);
    const systemPromptBase = [
      interpolatedPrompt,
      `Today is ${today}.`,
      'Respond in Portuguese (BR) unless the message is in English.',
    ].join('\n');

    const historyContext = contextManager.buildHistoryContext({
      agentId,
      source: input.source,
      model: agentConfig.model,
      systemPromptBaseTokens: contextManager.estimateTokens(systemPromptBase),
      memoryContextTokens: contextManager.estimateTokens(memoryContext),
    });

    const systemPrompt = [
      systemPromptBase,
      memoryContext,
      '',
      historyContext,
    ].filter(Boolean).join('\n');

    // Resolve MCP servers
    // Build knowledge source MCP servers for configured sources
    const knowledgeServers: Record<string, any> = {};
    const agentKnowledgeSources: string[] = (() => {
      try { return JSON.parse(agentConfig.knowledge_sources || '[]'); } catch { return []; }
    })();

    if (this.knowledgeManager && agentKnowledgeSources.length > 0) {
      for (const sourceId of agentKnowledgeSources) {
        const adapter = this.knowledgeManager.getAdapter(sourceId);
        if (!adapter) continue;
        const source = this.db.getKnowledgeSource(sourceId);
        const sourceName = source?.name ?? sourceId;
        knowledgeServers[`knowledge-${sourceId}`] = this.buildKnowledgeMcpServer(adapter, sourceName);
      }
    }

    const hasKnowledgeServers = Object.keys(knowledgeServers).length > 0;

    // Use sandbox-aware vault tools when a sandbox is provided
    const vaultMcpServer = sandbox
      ? this.buildMcpServer(sandbox)
      : this.mcpServer;
    if (sandbox) {
      console.log(`[agent-service] Using sandboxed tool execution for agent "${agentConfig.name}"`);
    }

    // Build memory MCP server (scoped to this request's agentId + userId)
    const memoryMcpServer = config.agentMemoryEnabled
      ? buildMemoryMcpServer(this.db, agentId, input.userId)
      : null;

    // Resolve which MCP connections this agent is allowed to use
    const agentMcpServerIds: string[] = (() => {
      try { return JSON.parse(agentConfig.mcp_servers || '[]'); } catch { return []; }
    })();

    let mcpServers: Record<string, any>;
    if (input.userId && this.mcpGateway) {
      const governedServers = await this.mcpGateway.resolveServers(input.userId, agentId);
      mcpServers = {
        ...(!hasKnowledgeServers ? { 'vault-tools': vaultMcpServer } : {}),
        ...knowledgeServers,
        ...(memoryMcpServer ? { 'memory-tools': memoryMcpServer } : {}),
        ...governedServers,
      };
    } else {
      // No userId — filter external MCP servers by agent's configured mcp_servers list.
      // This prevents agents from accessing tools they weren't assigned to.
      const allExternal = this.getExternalMcpServers();
      const filteredExternal: Record<string, any> = {};
      if (agentMcpServerIds.length > 0) {
        // Build a lookup: connection ID → connection type (e.g., 'shiplens')
        const connectionTypes = new Map<string, string>();
        for (const connId of agentMcpServerIds) {
          const conn = this.db.getConnection(connId);
          if (conn) connectionTypes.set(conn.type, connId);
        }
        // Only include external servers whose key matches an allowed connection type
        for (const [key, value] of Object.entries(allExternal)) {
          if (connectionTypes.has(key) || agentMcpServerIds.includes(key)) {
            filteredExternal[key] = value;
          }
        }
      }
      // If agent has NO mcp_servers configured, give NO external tools (secure default)
      mcpServers = {
        ...(!hasKnowledgeServers ? { 'vault-tools': vaultMcpServer } : {}),
        ...knowledgeServers,
        ...(memoryMcpServer ? { 'memory-tools': memoryMcpServer } : {}),
        ...filteredExternal,
      };
    }

    let resultText = '';

    try {
      for await (const message of query({
        prompt: input.text,
        options: {
          systemPrompt,
          model: agentConfig.model,
          maxTurns: agentConfig.max_turns,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          mcpServers,
        },
      })) {
        if ('result' in message) {
          resultText = message.result ?? '';
        }
      }
    } catch (err) {
      console.error(`[agent-service] Error with agent ${agentId}:`, err);
      // Retry once without MCP tools
      try {
        for await (const message of query({
          prompt: input.text,
          options: {
            systemPrompt,
            model: agentConfig.model,
            maxTurns: Math.min(agentConfig.max_turns, 10),
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
          },
        })) {
          if ('result' in message) {
            resultText = message.result ?? '';
          }
        }
      } catch (retryErr) {
        console.error('[agent-service] Retry failed:', retryErr);
        resultText = 'Error processing request. Please try again.';
      }
    }

    // Flush any vault writes
    await this.gitSync.flush();

    const durationMs = Date.now() - startTime;

    // Only log successful conversations — never pollute history with error messages
    if (resultText && resultText !== 'Error processing request. Please try again.' && resultText !== 'Agent execution timed out.') {
      this.db.logConversation({
        source: input.source,
        input: input.text,
        output: resultText,
        agentId,
        durationMs,
      });
    }

    return { text: resultText };
  }
}
