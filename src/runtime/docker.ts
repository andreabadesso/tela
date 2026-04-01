import type { DatabaseService } from '../services/database.js';
import type {
  AgentRuntime,
  AgentExecutionParams,
  AgentExecutionHandle,
  AgentRunStatus,
  AgentStreamEvent,
  DockerRuntimeConfig,
} from '../types/runtime.js';
import type { AgentOutput } from '../types/index.js';

/**
 * DockerRuntime — spawns an isolated container per agent run.
 * Uses dockerode for Docker Engine API communication.
 * Container runs agent-worker.ts, communicates back via HTTP callback.
 */
export class DockerRuntime implements AgentRuntime {
  readonly name = 'docker';
  private docker: any = null;          // Dockerode instance (lazy-loaded)
  private pendingResults = new Map<string, {
    resolve: (result: AgentOutput) => void;
    reject: (err: Error) => void;
    events: AgentStreamEvent[];
  }>();

  constructor(
    private db: DatabaseService,
    private config: DockerRuntimeConfig = {},
  ) {}

  private async getDocker() {
    if (!this.docker) {
      try {
        const Dockerode = (await import('dockerode')).default;
        this.docker = new Dockerode();
        // Verify Docker is accessible
        await this.docker.ping();
      } catch (err) {
        this.docker = null;
        throw new Error(`Docker not available: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return this.docker;
  }

  async execute(params: AgentExecutionParams): Promise<AgentExecutionHandle> {
    const docker = await this.getDocker();
    const runId = crypto.randomUUID();
    const timeout = params.timeout ?? 300_000;
    const image = this.config.image ?? 'tela-agent-worker:latest';

    // Record run in DB
    this.db.createAgentRun({
      id: runId,
      agent_id: params.agentId,
      runtime: this.name,
      input: JSON.stringify(params.input),
    });

    // Build environment for the agent worker
    const env = [
      `AGENT_RUN_ID=${runId}`,
      `AGENT_ID=${params.agentId}`,
      `AGENT_INPUT=${JSON.stringify(params.input)}`,
      `AGENT_CONFIG=${JSON.stringify(params.config)}`,
      `AGENT_MCP_SERVERS=${JSON.stringify(params.mcpServers)}`,
      `AGENT_TIMEOUT=${timeout}`,
      `CALLBACK_URL=http://host.docker.internal:${this.config.hostCallbackPort ?? 3000}/internal/mcp-proxy/result`,
      `MCP_PROXY_URL=http://host.docker.internal:${this.config.hostCallbackPort ?? 3000}/internal/mcp-proxy`,
    ];

    if (params.userId) {
      env.push(`AGENT_USER_ID=${params.userId}`);
    }

    // Resource limits
    const memoryBytes = (params.resources?.maxMemoryMb ?? 512) * 1024 * 1024;
    const cpuShares = params.resources?.maxCpuShares ?? 1024;

    // Set up result promise
    const resultPromise = new Promise<AgentOutput>((resolve, reject) => {
      this.pendingResults.set(runId, { resolve, reject, events: [] });
    });

    // Create and start container
    const startedAt = new Date();
    let containerId: string;

    try {
      const container = await docker.createContainer({
        Image: image,
        Cmd: ['node', 'dist/agent-worker.js'],
        Env: env,
        HostConfig: {
          Memory: memoryBytes,
          CpuShares: cpuShares,
          NetworkMode: this.config.network ?? 'bridge',
          ExtraHosts: ['host.docker.internal:host-gateway'],
          AutoRemove: false, // we clean up after collecting results
        },
        Labels: {
          'tela.run-id': runId,
          'tela.agent-id': params.agentId,
        },
      });

      containerId = container.id;
      await container.start();

      this.db.updateAgentRun(runId, {
        status: 'running',
        started_at: startedAt.toISOString(),
        container_id: containerId,
      });

      // Monitor container lifecycle
      this.monitorContainer(runId, container, timeout, startedAt);
    } catch (err) {
      const durationMs = Date.now() - startedAt.getTime();
      this.db.updateAgentRun(runId, {
        status: 'failed',
        error: `Container start failed: ${err instanceof Error ? err.message : String(err)}`,
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
      });

      const pending = this.pendingResults.get(runId);
      if (pending) {
        pending.reject(err instanceof Error ? err : new Error(String(err)));
        this.pendingResults.delete(runId);
      }

      throw err;
    }

    const stream = this.createStream(runId);

    return { runId, stream, result: resultPromise };
  }

  /**
   * Called by the MCP proxy route when a container posts its result back.
   */
  resolveRun(runId: string, result: AgentOutput): void {
    const pending = this.pendingResults.get(runId);
    if (pending) {
      pending.resolve(result);
      this.pendingResults.delete(runId);
    }
  }

  /**
   * Called by the MCP proxy route when a container streams an event.
   */
  pushEvent(runId: string, event: AgentStreamEvent): void {
    const pending = this.pendingResults.get(runId);
    if (pending) {
      pending.events.push(event);
    }
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
    const run = this.db.getAgentRun(runId);
    if (!run?.container_id) return;

    try {
      const docker = await this.getDocker();
      const container = docker.getContainer(run.container_id);
      await container.stop({ t: 5 }); // 5s grace period
      await container.remove({ force: true });
    } catch {
      // Container may already be stopped/removed
    }

    const durationMs = run.started_at
      ? Date.now() - new Date(run.started_at).getTime()
      : 0;

    this.db.updateAgentRun(runId, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });

    const pending = this.pendingResults.get(runId);
    if (pending) {
      pending.reject(new Error('Run cancelled'));
      this.pendingResults.delete(runId);
    }
  }

  async *logs(runId: string): AsyncIterable<string> {
    const run = this.db.getAgentRun(runId);
    if (!run) {
      yield `[error] Run ${runId} not found`;
      return;
    }
    yield `[${run.status}] Agent run ${runId} (docker, container: ${run.container_id ?? 'n/a'})`;

    // Try to get container logs
    if (run.container_id) {
      try {
        const docker = await this.getDocker();
        const container = docker.getContainer(run.container_id);
        const logStream = await container.logs({ stdout: true, stderr: true, follow: false });
        const logText = typeof logStream === 'string' ? logStream : logStream.toString();
        for (const line of logText.split('\n')) {
          if (line.trim()) yield line;
        }
      } catch {
        yield `[info] Container logs unavailable (may have been removed)`;
      }
    }

    if (run.error) yield `[error] ${run.error}`;
  }

  private async monitorContainer(
    runId: string,
    container: any,
    timeout: number,
    startedAt: Date,
  ): Promise<void> {
    const timer = setTimeout(async () => {
      // Timeout — kill the container
      try {
        await container.stop({ t: 2 });
        await container.remove({ force: true });
      } catch { /* already gone */ }

      const durationMs = Date.now() - startedAt.getTime();
      this.db.updateAgentRun(runId, {
        status: 'timeout',
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
        error: `Timed out after ${timeout}ms`,
      });

      const pending = this.pendingResults.get(runId);
      if (pending) {
        pending.resolve({ text: 'Agent execution timed out.' });
        this.pendingResults.delete(runId);
      }
    }, timeout);

    try {
      // Wait for container to exit
      const result = await container.wait();
      clearTimeout(timer);

      const durationMs = Date.now() - startedAt.getTime();
      const exitCode = result.StatusCode;

      // Collect resource usage from container stats (best effort)
      let resourceUsage: string | null = null;
      try {
        const stats = await container.stats({ stream: false });
        resourceUsage = JSON.stringify({
          peakMemoryMb: Math.round((stats.memory_stats?.max_usage ?? 0) / 1024 / 1024),
          cpuSeconds: 0, // simplified
        });
      } catch { /* stats unavailable */ }

      if (exitCode === 0) {
        // Result should have been posted via callback already
        // If not, mark as failed
        const pending = this.pendingResults.get(runId);
        if (pending) {
          // Give a brief window for the callback to arrive
          await new Promise(r => setTimeout(r, 500));
          if (this.pendingResults.has(runId)) {
            // Still pending — container exited without posting result
            this.db.updateAgentRun(runId, {
              status: 'failed',
              completed_at: new Date().toISOString(),
              duration_ms: durationMs,
              error: 'Container exited without posting result',
              resource_usage: resourceUsage,
            });
            pending.reject(new Error('Container exited without posting result'));
            this.pendingResults.delete(runId);
          }
        } else {
          // Result was already resolved via callback
          this.db.updateAgentRun(runId, {
            completed_at: new Date().toISOString(),
            duration_ms: durationMs,
            resource_usage: resourceUsage,
          });
        }
      } else if (exitCode === 137) {
        // OOM killed
        this.db.updateAgentRun(runId, {
          status: 'failed',
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
          error: `Container OOM killed (exit code 137)`,
          resource_usage: resourceUsage,
        });
        const pending = this.pendingResults.get(runId);
        if (pending) {
          pending.reject(new Error('Container OOM killed'));
          this.pendingResults.delete(runId);
        }
      } else {
        // Other failure
        this.db.updateAgentRun(runId, {
          status: 'failed',
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
          error: `Container exited with code ${exitCode}`,
          resource_usage: resourceUsage,
        });
        const pending = this.pendingResults.get(runId);
        if (pending) {
          pending.reject(new Error(`Container exited with code ${exitCode}`));
          this.pendingResults.delete(runId);
        }
      }

      // Cleanup container
      try { await container.remove({ force: true }); } catch { /* already removed or auto-removed */ }
    } catch (err) {
      clearTimeout(timer);
      // Container.wait() failed — likely container already gone
      const durationMs = Date.now() - startedAt.getTime();
      this.db.updateAgentRun(runId, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
        error: `Container monitoring failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      const pending = this.pendingResults.get(runId);
      if (pending) {
        pending.reject(err instanceof Error ? err : new Error(String(err)));
        this.pendingResults.delete(runId);
      }
    }
  }

  private async *createStream(runId: string): AsyncIterable<AgentStreamEvent> {
    yield { type: 'status', data: { state: 'running', runtime: 'docker' }, timestamp: Date.now() };

    // Poll for events from the pending results
    const pending = this.pendingResults.get(runId);
    if (!pending) return;

    let lastIndex = 0;
    while (this.pendingResults.has(runId)) {
      if (pending.events.length > lastIndex) {
        for (let i = lastIndex; i < pending.events.length; i++) {
          yield pending.events[i];
        }
        lastIndex = pending.events.length;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    // Yield any remaining events
    for (let i = lastIndex; i < pending.events.length; i++) {
      yield pending.events[i];
    }

    yield { type: 'status', data: { state: 'completed' }, timestamp: Date.now() };
  }
}
