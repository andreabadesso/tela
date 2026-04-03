import { spawn } from 'node:child_process';
import type { DatabaseService } from '../core/database.js';
import type { AgentService } from '../agent/service.js';
import type {
  AgentRuntime,
  AgentExecutionParams,
  AgentExecutionHandle,
  AgentRunStatus,
  AgentStreamEvent,
} from '../types/runtime.js';
import type { AgentOutput } from '../types/index.js';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { WorkspaceManager, type DevContainerConfig } from './workspace-manager.js';
import { PortProxyManager } from './port-proxy.js';

/**
 * DevContainerRuntime — persistent, long-lived containers for coding agents.
 *
 * Architecture: Claude Code runs INSIDE the Docker container via `spawnClaudeCodeProcess`.
 * This means all built-in tools (Bash, Write, Read, Edit, Glob, Grep) naturally
 * execute inside the container — no sandbox escape possible.
 *
 * The SDK's IPC (stdin/stdout) flows through `docker exec -i`, so host-side
 * MCP servers (memory, schedules, knowledge) still work via the SDK's proxy.
 */
export class DevContainerRuntime implements AgentRuntime {
  readonly name = 'devcontainer';
  private docker: any = null;
  readonly workspaceManager: WorkspaceManager;
  readonly portProxy: PortProxyManager;
  private activeRuns = new Map<string, {
    abort: AbortController;
    startedAt: Date;
    workspaceId: string;
  }>();

  constructor(
    private agentService: AgentService,
    private db: DatabaseService,
    private config: DevContainerConfig = {},
  ) {
    this.portProxy = new PortProxyManager(config.portRange);
    this.workspaceManager = new WorkspaceManager(db, this.portProxy, config);
  }

  private async getDocker() {
    if (!this.docker) {
      const Dockerode = (await import('dockerode')).default;
      this.docker = new Dockerode();
      await this.docker.ping();
    }
    return this.docker;
  }

  async execute(params: AgentExecutionParams): Promise<AgentExecutionHandle> {
    await this.getDocker();
    const runId = crypto.randomUUID();
    const timeout = params.timeout ?? (this.config.defaultTimeoutMs ?? 1_800_000); // 30 min default

    // Record run in DB
    this.db.createAgentRun({
      id: runId,
      agent_id: params.agentId,
      runtime: this.name,
      input: JSON.stringify(params.input),
    });

    // Get or create a workspace for this agent
    const workspace = await this.workspaceManager.getOrCreate(params.agentId);
    const { containerId } = await this.workspaceManager.start(workspace.id);

    const abort = new AbortController();
    const startedAt = new Date();

    this.activeRuns.set(runId, { abort, startedAt, workspaceId: workspace.id });

    this.db.updateAgentRun(runId, {
      status: 'running',
      started_at: startedAt.toISOString(),
      container_id: containerId,
    });

    // Execute agent inside the container
    const resultPromise = this.runWithTimeout(runId, params, containerId, timeout, abort.signal);
    const stream = this.createStream(runId);

    return { runId, stream, result: resultPromise };
  }

  /**
   * Build a spawnClaudeCodeProcess function that runs Claude Code inside the container.
   * The SDK calls this instead of spawning a local process.
   */
  private buildContainerSpawn(containerId: string): (options: SpawnOptions) => SpawnedProcess {
    return (options: SpawnOptions): SpawnedProcess => {
      // Forward essential env vars to the container
      const envArgs: string[] = [];
      const envForward = [
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_ENTRYPOINT',
        'CLAUDE_AGENT_SDK_VERSION',
      ];
      for (const key of envForward) {
        const val = options.env[key];
        if (val) envArgs.push('-e', `${key}=${val}`);
      }

      // The SDK passes: command='node', args=['/host/path/to/cli.js', ...flags]
      // We need to use the Claude CLI installed inside the container instead.
      // Skip the first arg (host path to cli.js) and use the container's `claude` binary.
      const cliFlags = options.args.slice(1); // Drop the host cli.js path

      const dockerArgs = [
        'exec', '-i',
        '-w', '/workspace',
        ...envArgs,
        containerId,
        'claude',  // Claude Code CLI installed globally in the container
        ...cliFlags,
      ];

      console.log(`[devcontainer] Spawning Claude Code in ${containerId.slice(0, 12)} (${cliFlags.length} flags, auth: ${options.env['CLAUDE_CODE_OAUTH_TOKEN'] ? 'oauth' : options.env['ANTHROPIC_API_KEY'] ? 'api-key' : 'none'})`);

      const proc = spawn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: options.signal,
      });

      // Log stderr for debugging
      proc.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[devcontainer:claude] ${msg}`);
      });

      proc.on('error', (err) => {
        console.error(`[devcontainer] Process error:`, err.message);
      });

      proc.on('exit', (code, signal) => {
        console.log(`[devcontainer] Claude process exited (code: ${code}, signal: ${signal})`);
      });

      return proc as unknown as SpawnedProcess;
    };
  }

  async status(runId: string): Promise<AgentRunStatus> {
    const run = this.db.getAgentRun(runId);
    if (!run) return { state: 'failed', error: 'Run not found', durationMs: 0 };

    switch (run.status) {
      case 'pending':
        return { state: 'pending' };
      case 'running':
        return { state: 'running', startedAt: new Date(run.started_at!), turns: 0 };
      case 'completed':
        return {
          state: 'completed',
          result: run.output ? JSON.parse(run.output) : { text: '' },
          durationMs: run.duration_ms ?? 0,
        };
      case 'failed':
        return { state: 'failed', error: run.error ?? 'Unknown error', durationMs: run.duration_ms ?? 0 };
      case 'cancelled':
        return { state: 'cancelled', durationMs: run.duration_ms ?? 0 };
      case 'timeout':
        return { state: 'timeout', durationMs: run.duration_ms ?? 0 };
      default:
        return { state: 'failed', error: 'Unknown status', durationMs: 0 };
    }
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (active) {
      active.abort.abort();
    }

    const durationMs = active
      ? Date.now() - active.startedAt.getTime()
      : 0;

    this.db.updateAgentRun(runId, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });

    this.activeRuns.delete(runId);
    // Note: we do NOT stop/destroy the container — workspace persists
  }

  async *logs(runId: string): AsyncIterable<string> {
    const run = this.db.getAgentRun(runId);
    if (!run) {
      yield `[error] Run ${runId} not found`;
      return;
    }

    yield `[${run.status}] Agent run ${runId} (devcontainer, container: ${run.container_id ?? 'n/a'})`;

    const active = this.activeRuns.get(runId);
    if (active) {
      const ws = this.db.getWorkspace(active.workspaceId);
      if (ws) {
        yield `[workspace] ${ws.name} (${ws.id.slice(0, 8)}, volume: ${ws.volume_name})`;
        const mappings = JSON.parse(ws.port_mappings);
        for (const m of mappings) {
          yield `[port] :${m.containerPort} → ${m.url}`;
        }
      }
    }

    if (run.error) yield `[error] ${run.error}`;
  }

  // ─── Internal ─────────────────────────────────────────────

  private async runWithTimeout(
    runId: string,
    params: AgentExecutionParams,
    containerId: string,
    timeout: number,
    signal: AbortSignal,
  ): Promise<AgentOutput> {
    return new Promise<AgentOutput>(async (resolve, reject) => {
      const timer = setTimeout(() => {
        const durationMs = Date.now() - (this.activeRuns.get(runId)?.startedAt.getTime() ?? Date.now());
        this.db.updateAgentRun(runId, {
          status: 'timeout',
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
          error: `Timed out after ${timeout}ms`,
        });
        this.activeRuns.delete(runId);
        resolve({ text: 'Agent execution timed out.' });
      }, timeout);

      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Run cancelled'));
      });

      try {
        console.log(`[devcontainer] Starting agent execution for run ${runId} (container: ${containerId.slice(0, 12)})`);

        const result = await this.agentService.process(params.agentId, params.input, {
          spawnClaudeCodeProcess: this.buildContainerSpawn(containerId),
        });

        console.log(`[devcontainer] Agent execution completed for run ${runId}`);
        clearTimeout(timer);

        const durationMs = Date.now() - (this.activeRuns.get(runId)?.startedAt.getTime() ?? Date.now());
        this.db.updateAgentRun(runId, {
          status: 'completed',
          output: JSON.stringify(result),
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
        });

        this.activeRuns.delete(runId);
        resolve(result);
      } catch (err) {
        clearTimeout(timer);

        const error = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - (this.activeRuns.get(runId)?.startedAt.getTime() ?? Date.now());
        this.db.updateAgentRun(runId, {
          status: 'failed',
          error,
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
        });

        this.activeRuns.delete(runId);
        reject(err);
      }
    });
  }

  private async *createStream(runId: string): AsyncIterable<AgentStreamEvent> {
    yield { type: 'status', data: { state: 'running', runtime: 'devcontainer' }, timestamp: Date.now() };

    // Poll until the run completes
    while (this.activeRuns.has(runId)) {
      await new Promise(r => setTimeout(r, 500));
    }

    const run = this.db.getAgentRun(runId);
    yield {
      type: 'status',
      data: { state: run?.status ?? 'completed' },
      timestamp: Date.now(),
    };
  }
}
