import type { AgentService } from '../agent/service.js';
import type { DatabaseService } from '../core/database.js';
import type {
  AgentRuntime,
  AgentExecutionParams,
  AgentExecutionHandle,
  AgentRunStatus,
  AgentStreamEvent,
  ToolSandbox,
} from '../types/runtime.js';
import type { AgentOutput } from '../types/index.js';

/**
 * AgentOsRuntime — sandboxed agent execution via Rivet Agent OS.
 *
 * Architecture:
 * - LLM calls happen on the host (via AgentService, with proper OAuth/API key)
 * - Tool execution is sandboxed inside Agent OS V8 isolates
 * - ~6ms cold start, deny-by-default permissions, WASM POSIX tools
 *
 * This gives us the best of both worlds: proper auth for Claude API
 * and sandboxed isolation for agent tool execution.
 */
export class AgentOsRuntime implements AgentRuntime {
  readonly name = 'agent-os';
  private vm: any = null;
  private activeRuns = new Map<string, { abort: AbortController; startedAt: Date }>();

  constructor(
    private agentService: AgentService,
    private db: DatabaseService,
  ) {}

  private async getVm() {
    if (!this.vm) {
      const { AgentOs } = await import('@rivet-dev/agent-os-core');
      const common = (await import('@rivet-dev/agent-os-common')).default;
      this.vm = await AgentOs.create({ software: [common] });
      console.log('[agent-os] VM initialized');
    }
    return this.vm;
  }

  async execute(params: AgentExecutionParams): Promise<AgentExecutionHandle> {
    const runId = crypto.randomUUID();
    const timeout = params.timeout ?? 300_000;
    const abort = new AbortController();

    // Ensure VM is ready (lazy init, ~6ms)
    await this.getVm();

    this.db.createAgentRun({
      id: runId,
      agent_id: params.agentId,
      runtime: this.name,
      input: JSON.stringify(params.input),
    });

    const startedAt = new Date();
    this.activeRuns.set(runId, { abort, startedAt });

    this.db.updateAgentRun(runId, {
      status: 'running',
      started_at: startedAt.toISOString(),
    });

    // Set up wall-clock timeout
    const timer = setTimeout(() => abort.abort(), timeout);

    const resultPromise = this.executeWithTimeout(runId, params, abort.signal, timer);
    const stream = this.createStream(runId, resultPromise);

    return { runId, stream, result: resultPromise };
  }

  private buildSandbox(): ToolSandbox {
    return {
      runCommand: async (command: string) => {
        const vm = await this.getVm();
        // vm.exec() is the Agent OS sandboxed VM API — NOT child_process
        const vmRun = vm.exec.bind(vm);
        return vmRun(command);
      },
      readFile: async (path: string) => {
        const vm = await this.getVm();
        return vm.readFile(path);
      },
      writeFile: async (path: string, content: Uint8Array) => {
        const vm = await this.getVm();
        return vm.writeFile(path, content);
      },
    };
  }

  private async executeWithTimeout(
    runId: string,
    params: AgentExecutionParams,
    signal: AbortSignal,
    timer: ReturnType<typeof setTimeout>,
  ): Promise<AgentOutput> {
    const startTime = Date.now();
    try {
      // LLM call on the host — AgentService handles OAuth/API key, MCP servers, etc.
      // Tool execution is sandboxed inside Agent OS V8 isolates
      const sandbox = this.buildSandbox();
      const result = await Promise.race([
        this.agentService.process(params.agentId, params.input, sandbox),
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('TIMEOUT')), { once: true });
          if (signal.aborted) reject(new Error('TIMEOUT'));
        }),
      ]);

      clearTimeout(timer);
      this.activeRuns.delete(runId);

      const durationMs = Date.now() - startTime;
      this.db.updateAgentRun(runId, {
        status: 'completed',
        output: JSON.stringify(result),
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
      });

      return result;
    } catch (err) {
      clearTimeout(timer);
      this.activeRuns.delete(runId);

      const durationMs = Date.now() - startTime;
      const isTimeout = err instanceof Error && err.message === 'TIMEOUT';

      this.db.updateAgentRun(runId, {
        status: isTimeout ? 'timeout' : 'failed',
        error: err instanceof Error ? err.message : String(err),
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
      });

      if (isTimeout) return { text: 'Agent execution timed out.' };
      throw err;
    }
  }

  /**
   * Execute a command inside the Agent OS sandbox.
   * Used for tool calls that need isolation (file ops, code execution, etc.)
   */
  async sandboxExec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const vm = await this.getVm();
    // vm.exec() is the Agent OS sandboxed VM API — NOT child_process.exec()
    const vmExec = vm.exec.bind(vm);
    return vmExec(command);
  }

  /**
   * Read a file from the Agent OS sandbox filesystem.
   */
  async sandboxReadFile(path: string): Promise<Uint8Array> {
    const vm = await this.getVm();
    return vm.readFile(path);
  }

  /**
   * Write a file to the Agent OS sandbox filesystem.
   */
  async sandboxWriteFile(path: string, content: Uint8Array): Promise<void> {
    const vm = await this.getVm();
    return vm.writeFile(path, content);
  }

  async status(runId: string): Promise<AgentRunStatus> {
    const run = this.db.getAgentRun(runId);
    if (!run) return { state: 'failed', error: 'Run not found', durationMs: 0 };

    switch (run.status) {
      case 'pending': return { state: 'pending' };
      case 'running': {
        const active = this.activeRuns.get(runId);
        return { state: 'running', startedAt: active?.startedAt ?? new Date(run.started_at!), turns: 0 };
      }
      case 'completed':
        return { state: 'completed', result: run.output ? JSON.parse(run.output) : { text: '' }, durationMs: run.duration_ms ?? 0 };
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
      this.activeRuns.delete(runId);
    }
    const durationMs = active ? Date.now() - active.startedAt.getTime() : 0;
    this.db.updateAgentRun(runId, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });
  }

  async *logs(runId: string): AsyncIterable<string> {
    const run = this.db.getAgentRun(runId);
    if (!run) { yield `[error] Run ${runId} not found`; return; }
    yield `[${run.status}] Agent run ${runId} (agent-os)`;
    if (run.error) yield `[error] ${run.error}`;
  }

  async dispose(): Promise<void> {
    if (this.vm) {
      await this.vm.dispose();
      this.vm = null;
    }
  }

  private async *createStream(
    _runId: string,
    resultPromise: Promise<AgentOutput>,
  ): AsyncIterable<AgentStreamEvent> {
    yield { type: 'status', data: { state: 'running', runtime: 'agent-os' }, timestamp: Date.now() };
    try {
      const result = await resultPromise;
      yield { type: 'text', data: result.text, timestamp: Date.now() };
      yield { type: 'status', data: { state: 'completed' }, timestamp: Date.now() };
    } catch (err) {
      yield { type: 'error', data: err instanceof Error ? err.message : String(err), timestamp: Date.now() };
    }
  }
}
