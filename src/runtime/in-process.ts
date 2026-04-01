import type { AgentService } from '../services/agent-service.js';
import type { DatabaseService } from '../services/database.js';
import type {
  AgentRuntime,
  AgentExecutionParams,
  AgentExecutionHandle,
  AgentRunStatus,
  AgentStreamEvent,
} from '../types/runtime.js';
import type { AgentOutput } from '../types/index.js';

/**
 * InProcessRuntime — runs agents in the same Node.js process.
 * Wraps AgentService.process() with wall-clock timeout via AbortController.
 * Default runtime for local dev and single-user instances.
 */
export class InProcessRuntime implements AgentRuntime {
  readonly name = 'in-process';
  private activeRuns = new Map<string, { abort: AbortController; startedAt: Date }>();

  constructor(
    private agentService: AgentService,
    private db: DatabaseService,
  ) {}

  async execute(params: AgentExecutionParams): Promise<AgentExecutionHandle> {
    const runId = crypto.randomUUID();
    const timeout = params.timeout ?? 300_000; // 5 min default
    const abort = new AbortController();

    // Record run in DB
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

    // Execute and track
    const resultPromise = this.executeWithTimeout(runId, params, abort.signal, timer);

    // Simple pass-through stream (in-process doesn't stream intermediate events)
    const stream = this.createStream(runId, resultPromise);

    return { runId, stream, result: resultPromise };
  }

  async status(runId: string): Promise<AgentRunStatus> {
    const run = this.db.getAgentRun(runId);
    if (!run) return { state: 'failed', error: 'Run not found', durationMs: 0 };

    switch (run.status) {
      case 'pending':
        return { state: 'pending' };
      case 'running': {
        const active = this.activeRuns.get(runId);
        return {
          state: 'running',
          startedAt: active?.startedAt ?? new Date(run.started_at!),
          turns: 0,
        };
      }
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
      this.activeRuns.delete(runId);
    }
    const durationMs = active
      ? Date.now() - active.startedAt.getTime()
      : 0;
    this.db.updateAgentRun(runId, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });
  }

  async *logs(runId: string): AsyncIterable<string> {
    const run = this.db.getAgentRun(runId);
    if (!run) {
      yield `[error] Run ${runId} not found`;
      return;
    }
    yield `[${run.status}] Agent run ${runId} (${run.runtime})`;
    if (run.error) yield `[error] ${run.error}`;
    if (run.output) yield `[output] ${run.output.slice(0, 200)}...`;
  }

  private async executeWithTimeout(
    runId: string,
    params: AgentExecutionParams,
    signal: AbortSignal,
    timer: ReturnType<typeof setTimeout>,
  ): Promise<AgentOutput> {
    const startTime = Date.now();
    try {
      // Race between agent execution and abort signal
      const result = await Promise.race([
        this.agentService.process(params.agentId, params.input),
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

      if (isTimeout) {
        return { text: 'Agent execution timed out.' };
      }
      throw err;
    }
  }

  private async *createStream(
    _runId: string,
    resultPromise: Promise<AgentOutput>,
  ): AsyncIterable<AgentStreamEvent> {
    yield { type: 'status', data: { state: 'running' }, timestamp: Date.now() };
    try {
      const result = await resultPromise;
      yield { type: 'text', data: result.text, timestamp: Date.now() };
      yield { type: 'status', data: { state: 'completed' }, timestamp: Date.now() };
    } catch (err) {
      yield {
        type: 'error',
        data: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
    }
  }
}
