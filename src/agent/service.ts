import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { createVaultTools } from '../tools/vault.js';
import type { GitSync } from '../core/git.js';
import type { DatabaseService } from '../core/database.js';
import type { McpGateway } from './mcp-gateway.js';
import type { KnowledgeManager } from '../knowledge/manager.js';
import type { AgentInput, AgentOutput } from '../types/index.js';
import { config } from '../config/env.js';
import { buildMemoryContext, buildMemoryMcpServer } from './memory.js';
import { buildScheduleMcpServer, type ScheduleToolsContext } from '../tools/schedule-tools.js';
import { buildWorkspaceToolsMcpServer } from '../tools/workspace-tools.js';
import { buildInsforgeMcpServer } from './insforge-mcp-bridge.js';
import { APP_BUILDER_SYSTEM_PROMPT } from './app-builder-prompt.js';
import type { WorkspaceManager } from '../runtime/workspace-manager.js';
import { ConversationContextService } from './context.js';
import type { ToolSandbox, AgentStreamEvent } from '../types/runtime.js';
import type { JobRegistry } from '../jobs/registry.js';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

/** Options for container-spawned agent execution */
export interface ContainerExecOptions {
  /** Custom spawn function — runs Claude Code inside a container */
  spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess;
}

type VaultTools = ReturnType<typeof createVaultTools>;

export class AgentService {
  private mcpServer;
  private mcpGateway: McpGateway | null;
  private knowledgeManager: KnowledgeManager | null;
  private jobRegistry: JobRegistry | null = null;
  private workspaceManager: WorkspaceManager | null = null;

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

  /** Set the job registry so agents can schedule jobs via MCP tools. */
  setScheduleDeps(jobRegistry: JobRegistry): void {
    this.jobRegistry = jobRegistry;
  }

  /** Set the workspace manager so container agents can expose ports via MCP tools. */
  setWorkspaceDeps(workspaceManager: WorkspaceManager): void {
    this.workspaceManager = workspaceManager;
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

  /**
   * Prepare all context needed for a query: system prompt, MCP servers, execution mode.
   * Shared between processStream() and process().
   */
  private async prepareQueryContext(agentId: string, input: AgentInput, sandboxOrContainer?: ToolSandbox | ContainerExecOptions) {
    const agentConfig = this.db.getAgent(agentId);
    if (!agentConfig) throw new Error(`Agent not found: ${agentId}`);
    if (!agentConfig.enabled) throw new Error(`Agent is disabled: ${agentId}`);

    // SAFETY: agents configured for sandboxed runtimes must NEVER run unsandboxed on host
    if (!sandboxOrContainer) {
      try {
        const perms = JSON.parse(agentConfig.permissions || '{}');
        if (perms.runtime === 'devcontainer' || perms.runtime === 'docker' || perms.runtime === 'agent-os') {
          throw new Error(
            `BLOCKED: Agent "${agentConfig.name}" (${agentId}) requires runtime "${perms.runtime}" but no sandbox was provided. ` +
            `Refusing to execute unsandboxed on host filesystem.`
          );
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('BLOCKED:')) throw e;
      }
    }

    console.log(`[agent-service] Processing with agent "${agentConfig.name}" (${agentId}): "${input.text.slice(0, 100)}" (source: ${input.source})`);

    await this.gitSync.pull();

    const today = new Date().toLocaleDateString('pt-BR', {
      timeZone: config.timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    // App Builder agents use a fixed, non-user-configurable system prompt
    const isAppBuilder = (agentConfig as any).type === 'app-builder';
    const baseSystemPrompt = isAppBuilder ? APP_BUILDER_SYSTEM_PROMPT : agentConfig.system_prompt;
    const interpolatedPrompt = isAppBuilder ? baseSystemPrompt : this.interpolatePrompt(baseSystemPrompt, agentConfig.name);
    const memoryContext = buildMemoryContext(this.db, agentId, input.userId);

    const contextManager = new ConversationContextService(this.db);
    const now = new Date();
    const currentTime = now.toLocaleTimeString('pt-BR', {
      timeZone: config.timezone,
      hour: '2-digit',
      minute: '2-digit',
    });
    const currentIso = now.toISOString();

    const systemPromptParts = [
      interpolatedPrompt,
      `Today is ${today}. Current time: ${currentTime} (${currentIso}).`,
      'Respond in Portuguese (BR) unless the message is in English.',
    ];

    if (config.insforgeApiUrl) {
      systemPromptParts.push(
        '',
        [
          'You have access to InsForge tools (insforge MCP server) for backend, database, and storage.',
          'For deploying frontend apps, do NOT use InsForge create-deployment (it requires Vercel credentials). Use the workspace-tools MCP server instead:',
          '',
          'LIVE PREVIEW:',
          '  The dev server is usually already running from a previous session.',
          '  1. Check if running: curl -sf http://localhost:5173 > /dev/null 2>&1 && echo running || echo not-running',
          '  2. If NOT running:',
          '       cd /workspace/repo && npm run dev -- --host 0.0.0.0 > /tmp/dev-server.log 2>&1 &',
          '     Wait for ready: for i in $(seq 1 30); do curl -sf http://localhost:5173 > /dev/null 2>&1 && break; sleep 1; done',
          '  3. Call serve_workspace_app(api_port: 5173) to register/refresh the live preview URL.',
          '     (Call this even if the server was already running — it is idempotent.)',
          '',
          'FINAL DEPLOY (do this when you are done with all changes):',
          'Build the production bundle and register the static files using one of the two cases below.',
          '',
          'CASE A — backend is InsForge functions (most common):',
          '  1. Build the frontend with the correct base path and InsForge proxy URL:',
          '       cd /workspace/myapp/frontend && VITE_API_BASE_URL=/apps/$WORKSPACE_ID/__insforge/{your-function-slug} npm run build -- --base=/apps/$WORKSPACE_ID/',
          '     Example: if your function slug is "tasks-api", use VITE_API_BASE_URL=/apps/$WORKSPACE_ID/__insforge/tasks-api',
          '  2. In your frontend api.ts, use: const BASE = import.meta.env.VITE_API_BASE_URL ?? "";',
          '     Then call: fetch(`${BASE}/tasks`) — this maps to /__insforge/tasks-api/tasks on the server.',
          '  3. Call `serve_workspace_app(directory: "/workspace/myapp/frontend/dist")` — no api_port needed.',
          '  NOTE: do NOT use the InsForge internal URL (localhost:7130 etc.) — the browser cannot reach it.',
          '  NOTE: do NOT use /functions/v1/{slug} paths — InsForge serves functions at /{slug}/... directly.',
          '  VITE_API_BASE_URL must include the function slug so fetch calls map to the correct function.',
          '',
          'CASE B — backend is a local process running inside this container:',
          '  1. Start the backend: e.g. `cd /workspace/myapp/api && node server.js &` (use port 3001, not 3000)',
          '  2. Build the frontend: cd /workspace/myapp/frontend && npm run build -- --base=/apps/$WORKSPACE_ID/',
          '  3. Call `serve_workspace_app(directory: "...", api_port: 3001)` to register both.',
          '  NOTE: the frontend must use relative fetch paths (fetch("api/tasks") not fetch("/api/tasks")).',
          '',
          'IMPORTANT: Always call serve_workspace_app(api_port: 5173) at the start to give a live preview.',
          'Always call serve_workspace_app(directory: "dist") (or the appropriate path) at the end to make the deploy permanent.',
        ].join('\n'),
      );
    }

    if (this.jobRegistry) {
      systemPromptParts.push(
        '',
        [
          'You have scheduling capabilities via the schedule-tools MCP server.',
          'When the user asks you to do something later, at a specific time, or on a recurring basis, use the schedule_job tool instead of doing it immediately.',
          'For one-shot tasks use type "one_shot" with a run_at ISO datetime. For recurring tasks use type "cron" with a cron_expression.',
          'You can also list and manage existing scheduled jobs.',
          'ABSOLUTE RULE: NEVER refuse, question, or suggest alternatives to the timing the user asks for. 5 seconds, 10 seconds, 1 second — it does not matter. Schedule EXACTLY what was asked. Do NOT say "that is too short" or suggest longer times. Just call schedule_job immediately.',
          'For short delays (under 5 minutes), ALWAYS use delay_seconds instead of run_at. This avoids timing issues. Example: "in 10 seconds" → delay_seconds: 10. "in 2 minutes" → delay_seconds: 120.',
          '',
          'IMPORTANT about scheduled job mode and prompts:',
          '- Use mode "message" for simple notifications/reminders — the prompt text is delivered literally as-is. Example: user says "send me hi in 5 min" → mode: "message", prompt: "hi".',
          '- Use mode "agent" for complex tasks that need agent processing — the prompt is executed by the agent and the result is delivered. Example: user says "generate a report in 1 hour" → mode: "agent", prompt: "Generate a daily report from the vault".',
          '- Delivery is handled by target_channel — do NOT include delivery instructions in the prompt.',
          '',
          'IMPORTANT about target_channel (format: "platform:destination"):',
          'If the request comes from a channel (e.g., Telegram, Slack), the source channel is used as the default — you do not need to ask.',
          'But if the user asks to deliver the result to a DIFFERENT channel than the current one (e.g., "send it on Slack" while chatting on Telegram), you MUST set target_channel explicitly and ask which specific channel/user/group to send it to if unclear.',
          'Never schedule a job to a channel without knowing the destination.',
        ].join('\n'),
      );
    }

    const systemPromptBase = systemPromptParts.join('\n');

    const historyContext = contextManager.buildHistoryContext({
      agentId,
      source: input.source,
      model: agentConfig.model,
      systemPromptBaseTokens: contextManager.estimateTokens(systemPromptBase),
      memoryContextTokens: contextManager.estimateTokens(memoryContext),
    });

    // Inject project context block when provided (App Builder sessions)
    const projectContext = input.metadata?.projectContext as string | undefined;

    const systemPrompt = [
      systemPromptBase,
      input.instructions || '',
      projectContext || '',
      isAppBuilder ? '' : memoryContext,  // App Builder doesn't use conversation memory
      '',
      historyContext,
    ].filter(Boolean).join('\n');

    // Build knowledge source MCP servers
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

    // Determine execution mode
    const isContainerExec = sandboxOrContainer && 'spawnClaudeCodeProcess' in sandboxOrContainer;
    const sandbox = isContainerExec ? undefined : sandboxOrContainer as ToolSandbox | undefined;
    const containerExec = isContainerExec ? sandboxOrContainer as ContainerExecOptions : undefined;

    if (containerExec) {
      console.log(`[agent-service] Using container execution for agent "${agentConfig.name}"`);
    } else if (sandbox) {
      console.log(`[agent-service] Using sandboxed tool execution for agent "${agentConfig.name}"`);
    }

    const vaultMcpServer = sandbox
      ? this.buildMcpServer(sandbox)
      : this.mcpServer;

    const memoryMcpServer = config.agentMemoryEnabled
      ? buildMemoryMcpServer(this.db, agentId, input.userId)
      : null;

    const scheduleContext: ScheduleToolsContext = {
      sourceChannelId: input.metadata?.channelId as string | undefined,
      sourceThreadId: input.metadata?.threadId as string | undefined,
      sourcePlatform: input.source !== 'web' && input.source !== 'schedule' && input.source !== 'cron'
        ? input.source
        : undefined,
    };
    const scheduleMcpServer = this.jobRegistry
      ? buildScheduleMcpServer(this.db, this.jobRegistry, this, agentId, scheduleContext)
      : null;

    const agentMcpServerIds: string[] = (() => {
      try { return JSON.parse(agentConfig.mcp_servers || '[]'); } catch { return []; }
    })();

    let mcpServers: Record<string, any>;

    if (containerExec) {
      const insforgeUrl = config.insforgeApiUrl.replace('host.docker.internal', 'localhost');
      const workspaceHostPath = input.metadata?.workspaceHostPath as string | undefined;
      const workspaceId = input.metadata?.workspaceId as string | undefined;
      const insforgeMcp = config.insforgeApiUrl
        ? await buildInsforgeMcpServer(insforgeUrl, config.insforgeApiKey, workspaceHostPath)
        : null;
      const workspaceMcp = (workspaceId && this.workspaceManager)
        ? buildWorkspaceToolsMcpServer(workspaceId, this.workspaceManager)
        : null;

      if (isAppBuilder) {
        // App Builder: restricted tool set — InsForge + workspace tools only, no memory/schedules/external
        mcpServers = {
          ...(insforgeMcp ? { 'insforge': insforgeMcp } : {}),
          ...(workspaceMcp ? { 'workspace-tools': workspaceMcp } : {}),
        };
      } else {
        mcpServers = {
          ...knowledgeServers,
          ...(memoryMcpServer ? { 'memory-tools': memoryMcpServer } : {}),
          ...(scheduleMcpServer ? { 'schedule-tools': scheduleMcpServer } : {}),
          ...(insforgeMcp ? { 'insforge': insforgeMcp } : {}),
          ...(workspaceMcp ? { 'workspace-tools': workspaceMcp } : {}),
        };
      }
    } else if (input.userId && this.mcpGateway) {
      const governedServers = await this.mcpGateway.resolveServers(input.userId, agentId);
      mcpServers = {
        ...(!hasKnowledgeServers ? { 'vault-tools': vaultMcpServer } : {}),
        ...knowledgeServers,
        ...(memoryMcpServer ? { 'memory-tools': memoryMcpServer } : {}),
        ...(scheduleMcpServer ? { 'schedule-tools': scheduleMcpServer } : {}),
        ...governedServers,
      };
    } else {
      const allExternal = this.getExternalMcpServers();
      const filteredExternal: Record<string, any> = {};
      if (agentMcpServerIds.length > 0) {
        const connectionTypes = new Map<string, string>();
        for (const connId of agentMcpServerIds) {
          const conn = this.db.getConnection(connId);
          if (conn) connectionTypes.set(conn.type, connId);
        }
        for (const [key, value] of Object.entries(allExternal)) {
          if (connectionTypes.has(key) || agentMcpServerIds.includes(key)) {
            filteredExternal[key] = value;
          }
        }
      }
      mcpServers = {
        ...(!hasKnowledgeServers ? { 'vault-tools': vaultMcpServer } : {}),
        ...knowledgeServers,
        ...(memoryMcpServer ? { 'memory-tools': memoryMcpServer } : {}),
        ...(scheduleMcpServer ? { 'schedule-tools': scheduleMcpServer } : {}),
        ...filteredExternal,
      };
    }

    console.log(`[agent:${agentConfig.name}] MCP servers: ${Object.keys(mcpServers).join(', ') || 'none'}`);
    console.log(`[agent:${agentConfig.name}] Container exec: ${!!containerExec}, Sandbox: ${!!sandbox}`);

    return { agentConfig, systemPrompt, mcpServers, sandbox, containerExec };
  }

  /**
   * Streaming agent execution — yields AgentStreamEvent as the SDK query() loop progresses.
   * Callers get real-time thinking, text, tool_call, tool_result, status, and error events.
   */
  async *processStream(
    agentId: string,
    input: AgentInput,
    sandboxOrContainer?: ToolSandbox | ContainerExecOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    const startTime = Date.now();
    const ts = () => Date.now();

    const { agentConfig, systemPrompt, mcpServers, sandbox, containerExec } =
      await this.prepareQueryContext(agentId, input, sandboxOrContainer);

    yield { type: 'status', message: 'Thinking...', timestamp: ts() };

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
          ...(containerExec ? { spawnClaudeCodeProcess: containerExec.spawnClaudeCodeProcess } : {}),
          ...(sandbox ? { tools: [] } : {}),
          stderr: (data: string) => {
            const line = data.trim();
            if (line) console.log(`[agent:${agentConfig.name}] ${line}`);
          },
        },
      })) {
        // Cancel support
        if (signal?.aborted) {
          yield { type: 'status', message: 'Cancelled', timestamp: ts() };
          break;
        }

        const m = message as Record<string, unknown>;

        if ('result' in message) {
          resultText = message.result ?? '';
          console.log(`[agent:${agentConfig.name}] done (${resultText.length} chars)`);
        } else if (m.type === 'assistant') {
          const msg = m.message as Record<string, unknown> | undefined;
          const content = (msg?.content ?? m.content) as Array<Record<string, unknown>> | undefined;
          if (content) {
            for (const block of content) {
              if (block.type === 'tool_use') {
                const toolName = block.name as string;
                console.log(`[agent:${agentConfig.name}] tool: ${toolName} ${block.input ? JSON.stringify(block.input).slice(0, 100) : ''}`);
                yield {
                  type: 'tool_call',
                  name: toolName,
                  args: block.input,
                  toolCallId: block.id as string | undefined,
                  timestamp: ts(),
                };
                yield { type: 'status', message: `Using tool: ${toolName}`, timestamp: ts() };
              } else if (block.type === 'thinking') {
                const text = (block.thinking as string) ?? '';
                if (text.length > 0) {
                  console.log(`[agent:${agentConfig.name}] thinking (${text.length} chars)`);
                  yield { type: 'thinking', text, timestamp: ts() };
                }
              } else if (block.type === 'text') {
                const text = (block.text as string) ?? '';
                if (text.length > 0) {
                  console.log(`[agent:${agentConfig.name}] text: ${text.slice(0, 150)}`);
                  yield { type: 'text', text, timestamp: ts() };
                }
              }
            }
          }
        } else if (m.type === 'tool_result' || m.subtype === 'tool_result') {
          console.log(`[agent:${agentConfig.name}] tool_result`);
          yield {
            type: 'tool_result',
            toolCallId: m.tool_use_id as string | undefined,
            content: typeof m.content === 'string' ? m.content : undefined,
            timestamp: ts(),
          };
        } else if (m.type === 'system') {
          const subtype = m.subtype as string ?? '';
          if (subtype === 'task_started') {
            console.log(`[agent:${agentConfig.name}] sub-agent started: ${m.description}`);
            yield { type: 'status', message: `Sub-agent: ${m.description}`, timestamp: ts() };
          } else if (subtype === 'task_completed') {
            console.log(`[agent:${agentConfig.name}] sub-agent completed`);
            yield { type: 'status', message: 'Sub-agent completed', timestamp: ts() };
          } else {
            console.log(`[agent:${agentConfig.name}] system: ${subtype}`);
          }
        } else if (m.type === 'error') {
          console.error(`[agent:${agentConfig.name}] error:`, m.error);
          yield { type: 'error', message: String(m.error), timestamp: ts() };
        } else {
          console.log(`[agent:${agentConfig.name}] msg: ${m.type}${m.subtype ? '/' + m.subtype : ''}`);
        }
      }
    } catch (err) {
      console.error(`[agent-service] Error with agent ${agentId}:`, err);
      yield { type: 'error', message: err instanceof Error ? err.message : 'Unknown error', timestamp: ts() };
    }

    // Flush vault writes
    await this.gitSync.flush();

    const durationMs = Date.now() - startTime;

    // Log conversation
    if (resultText && resultText !== 'Error processing request. Please try again.' && resultText !== 'Agent execution timed out.') {
      this.db.logConversation({
        source: input.source,
        input: input.text,
        output: resultText,
        agentId,
        durationMs,
      });
    }

    // Yield final result
    yield { type: 'result', text: resultText, durationMs, timestamp: ts() };
  }

  /**
   * Non-streaming agent execution — consumes processStream() and returns the final text.
   * Retries once without MCP tools for non-sandboxed agents on error.
   */
  async process(agentId: string, input: AgentInput, sandboxOrContainer?: ToolSandbox | ContainerExecOptions): Promise<AgentOutput> {
    let resultText = '';
    let hadError = false;

    for await (const event of this.processStream(agentId, input, sandboxOrContainer)) {
      if (event.type === 'result') {
        resultText = event.text;
      } else if (event.type === 'error') {
        hadError = true;
      }
    }

    // Retry once without MCP tools for non-sandboxed agents
    if (hadError && !resultText) {
      const isContainerExec = sandboxOrContainer && 'spawnClaudeCodeProcess' in sandboxOrContainer;
      const sandbox = isContainerExec ? undefined : sandboxOrContainer as ToolSandbox | undefined;
      if (!sandbox && !isContainerExec) {
        const agentConfig = this.db.getAgent(agentId);
        if (agentConfig) {
          const { systemPrompt } = await this.prepareQueryContext(agentId, input);
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
      }
      if (!resultText) {
        resultText = 'Error processing request. Please try again.';
      }
    }

    return { text: resultText };
  }
}
