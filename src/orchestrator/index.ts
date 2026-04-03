import type { DatabaseService } from '../core/database.js';
import type { AgentService } from '../agent/service.js';
import type { AgentInput, AgentOutput } from '../types/index.js';
import type { AgentStreamEvent } from '../types/runtime.js';
import type { RuntimeRegistry } from '../runtime/index.js';

export class Orchestrator {
  private runtimeRegistry: RuntimeRegistry | null;

  constructor(
    private db: DatabaseService,
    private agentService: AgentService,
    runtimeRegistry?: RuntimeRegistry,
  ) {
    this.runtimeRegistry = runtimeRegistry ?? null;
  }

  /**
   * Chat mode: route to best agent based on input, then process via runtime.
   * If the resolved agent uses devcontainer runtime, auto-switches to background
   * mode and returns an acknowledgment immediately.
   */
  async chat(input: AgentInput): Promise<AgentOutput> {
    const agentId = await this.resolveAgent(input);

    // DevContainer agents: run inline for interactive sources (web, telegram)
    // so the result flows back through the same connection.
    // Only auto-background for non-interactive sources (API, A2A, schedule).
    if (this.isDevContainerAgent(agentId) && input.source !== 'web' && input.source !== 'telegram') {
      const runId = await this.assign(`auto:${crypto.randomUUID()}`, agentId, input.text);
      return {
        text: `Starting your coding task. I'll build this in a sandboxed workspace and update you when it's ready.\n\nRun ID: \`${runId}\``,
      };
    }

    return this.executeViaRuntime(agentId, input);
  }

  /** Check if an agent is configured to use the devcontainer runtime. */
  private isDevContainerAgent(agentId: string): boolean {
    const agent = this.db.getAgent(agentId);
    if (!agent) return false;
    try {
      const permissions = JSON.parse(agent.permissions || '{}');
      return permissions.runtime === 'devcontainer';
    } catch { return false; }
  }

  /**
   * Streaming chat — resolves the best agent and yields AgentStreamEvents in real-time.
   * For devcontainer agents, uses the runtime registry to execute inside a container.
   */
  async *chatStream(input: AgentInput, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
    const agentId = await this.resolveAgent(input);

    // DevContainer agents on non-interactive sources: background mode (no streaming)
    if (this.isDevContainerAgent(agentId) && input.source !== 'web' && input.source !== 'telegram') {
      const runId = await this.assign(`auto:${crypto.randomUUID()}`, agentId, input.text);
      yield {
        type: 'result',
        text: `Starting your coding task. I'll build this in a sandboxed workspace and update you when it's ready.\n\nRun ID: \`${runId}\``,
        durationMs: 0,
        timestamp: Date.now(),
      };
      return;
    }

    // For agents that require a sandboxed runtime, go through the runtime registry
    if (this.isDevContainerAgent(agentId)) {
      yield* this.streamViaRuntime(agentId, input, signal);
      return;
    }

    yield* this.agentService.processStream(agentId, input, undefined, signal);
  }

  /**
   * Stream an agent execution through the runtime registry.
   * Resolves the runtime, executes, and yields events from the handle's stream + result.
   */
  private async *streamViaRuntime(agentId: string, input: AgentInput, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
    if (!this.runtimeRegistry) {
      console.error(`[orchestrator] BLOCKED: Agent "${agentId}" requires sandboxed runtime but no registry configured`);
      yield { type: 'error', message: 'This agent requires a sandboxed runtime that is not currently configured.', timestamp: Date.now() };
      return;
    }

    const agent = this.db.getAgent(agentId);
    if (!agent) {
      yield { type: 'error', message: `Agent not found: ${agentId}`, timestamp: Date.now() };
      return;
    }

    const runtime = this.runtimeRegistry.resolve(agent);
    const startTime = Date.now();

    yield { type: 'status', message: `Starting ${runtime.name} runtime...`, timestamp: Date.now() };

    try {
      const handle = await runtime.execute({
        agentId,
        input,
        config: agent,
        mcpServers: [],
        userId: input.userId,
      });

      // Stream events from the runtime handle
      for await (const event of handle.stream) {
        if (signal?.aborted) {
          await runtime.cancel(handle.runId).catch(() => {});
          yield { type: 'status', message: 'Cancelled', timestamp: Date.now() };
          return;
        }
        yield event;
      }

      // Wait for the final result
      const result = await handle.result;
      yield { type: 'result', text: result.text, durationMs: Date.now() - startTime, timestamp: Date.now() };
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err), timestamp: Date.now() };
    }
  }

  /**
   * Batch mode: assign a task to an agent and run in background.
   * Returns the run_id for tracking.
   */
  async assign(taskRef: string, agentId: string, prompt: string): Promise<string> {
    const checkout = await this.checkoutTask(taskRef, agentId);
    // Run in background — don't await
    this.runBackground(checkout.run_id, agentId, prompt).catch(err => {
      console.error(`[orchestrator] Background task failed:`, err);
      this.releaseCheckout(checkout.run_id, 'cancelled');
    });
    return checkout.run_id;
  }

  /**
   * Council mode: multiple agents process the same query in parallel.
   */
  async council(input: AgentInput, agentIds: string[]): Promise<{ agentId: string; output: AgentOutput }[]> {
    const results = await Promise.all(
      agentIds.map(async (id) => ({
        agentId: id,
        output: await this.executeViaRuntime(id, input),
      })),
    );
    return results;
  }

  /**
   * Execute an agent via the runtime registry.
   * Falls back to direct AgentService.process() if no registry configured.
   * SAFETY: DevContainer agents are NEVER allowed to run unsandboxed.
   */
  private async executeViaRuntime(agentId: string, input: AgentInput): Promise<AgentOutput> {
    if (!this.runtimeRegistry) {
      // Hard guard: devcontainer agents must never run without a runtime (unsandboxed)
      if (this.isDevContainerAgent(agentId)) {
        console.error(`[orchestrator] BLOCKED: DevContainer agent "${agentId}" cannot run without runtime registry — would execute unsandboxed on host`);
        return { text: 'This agent requires a sandboxed runtime that is not currently configured. Please contact your administrator.' };
      }
      return this.agentService.process(agentId, input);
    }

    const agent = this.db.getAgent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const runtime = this.runtimeRegistry.resolve(agent);

    const handle = await runtime.execute({
      agentId,
      input,
      config: agent,
      mcpServers: [],
      userId: input.userId,
    });

    return handle.result;
  }

  /**
   * Intent routing — determine which agent should handle the input.
   */
  private async resolveAgent(input: AgentInput): Promise<string> {
    // 1. Check explicit mention: @cto, @ceo, etc.
    const mentionMatch = input.text.match(/@(\w+)/);
    if (mentionMatch) {
      const agents = this.db.getAgents();
      const found = agents.find(a =>
        a.name.toLowerCase().includes(mentionMatch[1].toLowerCase()) ||
        a.id === mentionMatch[1],
      );
      if (found) return found.id;
    }

    // 2. Check if metadata specifies an agent
    if (input.metadata?.agentId) return input.metadata.agentId as string;

    // 3. Default to first enabled agent
    const agents = this.db.getAgents();
    const enabled = agents.filter(a => a.enabled);
    return enabled[0]?.id ?? 'default';
  }

  /**
   * Task checkout — atomic, prevents double-work via UNIQUE constraint.
   */
  private async checkoutTask(taskRef: string, agentId: string) {
    const id = crypto.randomUUID();
    const runId = crypto.randomUUID();
    try {
      this.db.createTaskCheckout({ id, task_ref: taskRef, agent_id: agentId, run_id: runId });
      return { id, run_id: runId };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE constraint')) {
        throw new Error(`Task already checked out: ${taskRef}`);
      }
      throw err;
    }
  }

  private releaseCheckout(runId: string, status: 'completed' | 'cancelled') {
    this.db.releaseTaskCheckout(runId, status);
  }

  /**
   * Background execution with budget enforcement.
   */
  private async runBackground(runId: string, agentId: string, prompt: string): Promise<AgentOutput> {
    try {
      // Check budget before execution
      const budgetCheck = await this.checkBudget(agentId);
      if (budgetCheck === 'hard_stop') {
        throw new Error('Budget limit exceeded');
      }

      const input: AgentInput = { text: prompt, source: 'background' };
      const result = await this.executeViaRuntime(agentId, input);

      this.releaseCheckout(runId, 'completed');
      return result;
    } catch (err) {
      this.releaseCheckout(runId, 'cancelled');
      throw err;
    }
  }

  /**
   * Budget enforcement — check if agent is within budget limits.
   */
  async checkBudget(agentId: string): Promise<'ok' | 'soft_warning' | 'hard_stop'> {
    const policy = this.db.getBudgetPolicy(agentId);
    if (!policy) return 'ok';

    const spent = this.db.getMonthlySpend(agentId);
    const pct = (spent / policy.monthly_limit_cents) * 100;

    if (pct >= policy.hard_threshold_pct) {
      this.db.updateAgent(agentId, { enabled: 0 });
      this.db.createApproval({
        id: crypto.randomUUID(),
        agent_id: agentId,
        type: 'budget_override',
        context: JSON.stringify({ spent, limit: policy.monthly_limit_cents, pct }),
      });
      return 'hard_stop';
    }
    if (pct >= policy.soft_threshold_pct) return 'soft_warning';
    return 'ok';
  }
}
