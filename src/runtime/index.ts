import type { AgentRuntime, RuntimeType, DockerRuntimeConfig } from '../types/runtime.js';
import type { AgentService } from '../agent/service.js';
import type { DatabaseService } from '../core/database.js';
import type { AgentRow } from '../types/index.js';
import { InProcessRuntime } from './in-process.js';
import { DockerRuntime } from './docker.js';
import { AgentOsRuntime } from './agent-os.js';

export { InProcessRuntime } from './in-process.js';
export { DockerRuntime } from './docker.js';
export { AgentOsRuntime } from './agent-os.js';

/**
 * RuntimeRegistry — manages available runtimes and resolves which one to use.
 */
export class RuntimeRegistry {
  private runtimes = new Map<string, AgentRuntime>();
  private defaultRuntime: RuntimeType;

  constructor(defaultRuntime?: RuntimeType) {
    this.defaultRuntime = defaultRuntime ?? (process.env.AGENT_RUNTIME as RuntimeType) ?? 'in-process';
  }

  register(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.name, runtime);
  }

  get(name: string): AgentRuntime | undefined {
    return this.runtimes.get(name);
  }

  /**
   * Resolve which runtime to use for a given agent.
   * Priority: agent config override → env default → agent-os fallback → in-process fallback.
   */
  resolve(agent: AgentRow): AgentRuntime {
    // Check per-agent override
    let override: string | undefined;
    try {
      const permissions = JSON.parse(agent.permissions || '{}');
      override = permissions.runtime;
    } catch { /* ignore */ }

    const choice = override ?? this.defaultRuntime;
    const runtime = this.runtimes.get(choice);

    if (runtime) return runtime;

    // Fallback chain: agent-os → in-process
    const agentOs = this.runtimes.get('agent-os');
    if (agentOs) return agentOs;

    console.warn(`[runtime] Requested runtime "${choice}" not available, falling back to in-process`);
    const fallback = this.runtimes.get('in-process');
    if (!fallback) throw new Error('No runtime available (not even in-process)');
    return fallback;
  }

  getDefault(): AgentRuntime {
    const runtime = this.runtimes.get(this.defaultRuntime);
    if (runtime) return runtime;
    const agentOs = this.runtimes.get('agent-os');
    if (agentOs) return agentOs;
    const fallback = this.runtimes.get('in-process');
    if (!fallback) throw new Error('No runtime available');
    return fallback;
  }

  listAvailable(): string[] {
    return Array.from(this.runtimes.keys());
  }
}

/**
 * Create and configure the runtime registry.
 * Default: Agent OS (V8 isolates, ~6ms cold start, sandboxed).
 * Fallback: in-process if Agent OS unavailable.
 * Optional: Docker for full container isolation.
 */
export function createRuntimeRegistry(
  agentService: AgentService,
  db: DatabaseService,
  dockerConfig?: DockerRuntimeConfig,
): RuntimeRegistry {
  const registry = new RuntimeRegistry();

  // Always register in-process runtime (ultimate fallback)
  registry.register(new InProcessRuntime(agentService, db));

  // Register Agent OS runtime (default — V8 isolates, sandboxed tool execution)
  try {
    const agentOsRuntime = new AgentOsRuntime(agentService, db);
    registry.register(agentOsRuntime);
    console.log('[runtime] Agent OS runtime registered (default)');
  } catch (err) {
    console.warn('[runtime] Agent OS runtime registration failed:', err);
  }

  // Register Docker runtime if configured
  const wantsDocker = process.env.AGENT_RUNTIME === 'docker' || dockerConfig;
  if (wantsDocker) {
    try {
      const dockerRuntime = new DockerRuntime(db, dockerConfig);
      registry.register(dockerRuntime);
      console.log('[runtime] Docker runtime registered');
    } catch (err) {
      console.warn('[runtime] Docker runtime registration failed:', err);
    }
  }

  const defaultName = process.env.AGENT_RUNTIME ?? 'in-process';
  console.log(`[runtime] Available: ${registry.listAvailable().join(', ')} (default: ${defaultName})`);

  return registry;
}
