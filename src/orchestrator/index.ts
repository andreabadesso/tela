import type { DatabaseService } from '../services/database.js';
import type { AgentService } from '../services/agent-service.js';
import type { AgentInput, AgentOutput } from '../types/index.js';

export class Orchestrator {
  constructor(
    private db: DatabaseService,
    private agentService: AgentService,
  ) {}

  /**
   * Chat mode: route to best agent based on input, then process.
   */
  async chat(input: AgentInput): Promise<AgentOutput> {
    const agentId = await this.resolveAgent(input);
    return this.agentService.process(agentId, input);
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
        output: await this.agentService.process(id, input),
      })),
    );
    return results;
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

      const result = await this.agentService.process(agentId, {
        text: prompt,
        source: 'cron',
        // Background tasks don't have a user context
      });

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
