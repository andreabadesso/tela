import type { DatabaseService } from '../core/database.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { RuntimeRegistry } from '../runtime/index.js';
import type {
  A2ATask,
  A2ATaskState,
  A2ATaskStatus,
  A2AMessage,
  A2AArtifact,
  A2APushNotificationConfig,
  MessageSendParams,
  TaskGetParams,
  TaskListParams,
  TaskCancelParams,
  PushNotificationSetParams,
  PushNotificationGetParams,
  PushNotificationDeleteParams,
  TextPart,
} from './types.js';
import type { AgentRunRow } from '../types/runtime.js';
import { PushNotifier } from './push-notifier.js';

export class A2ATaskManager {
  private pushNotifier: PushNotifier;
  /** Active SSE subscriptions: taskId → Set of writable stream writers */
  private subscriptions = new Map<string, Set<(event: string) => void>>();

  constructor(
    private db: DatabaseService,
    private orchestrator: Orchestrator,
    private runtimeRegistry: RuntimeRegistry | null,
  ) {
    this.pushNotifier = new PushNotifier(db);
  }

  // ─── message/send ──────────────────────────────────────────

  async sendMessage(params: MessageSendParams): Promise<A2ATask> {
    const text = this.extractText(params.message);
    const skillId = params.skillId ?? this.resolveSkillFromMessage(text);
    const contextId = params.contextId ?? crypto.randomUUID();

    // Resuming an existing task?
    if (params.taskId) {
      return this.resumeTask(params.taskId, params.message, text);
    }

    // Create new agent run + a2a task
    const runId = crypto.randomUUID();
    const agentId = skillId ?? this.resolveDefaultAgent();

    this.db.createAgentRun({
      id: runId,
      agent_id: agentId,
      runtime: this.resolveRuntimeName(agentId),
      input: text,
    });

    const messages: A2AMessage[] = [params.message];
    this.db.createA2ATask({
      id: runId,
      context_id: contextId,
      skill_id: skillId ?? undefined,
      messages: JSON.stringify(messages),
      metadata: JSON.stringify(params.metadata ?? {}),
    });

    // Setup push notification if provided inline
    if (params.configuration?.pushNotificationConfig) {
      const config = params.configuration.pushNotificationConfig;
      this.db.createA2APushConfig({
        id: config.id ?? crypto.randomUUID(),
        task_id: runId,
        url: config.url,
        token: config.token,
        authentication: config.authentication ? JSON.stringify(config.authentication) : undefined,
      });
    }

    // Execute: blocking (sync) or non-blocking (background)
    const blocking = params.configuration?.blocking ?? false;

    if (blocking) {
      return this.executeBlocking(runId, agentId, text, messages);
    }
    return this.executeBackground(runId, agentId, text);
  }

  // ─── tasks/get ─────────────────────────────────────────────

  async getTask(params: TaskGetParams): Promise<A2ATask | null> {
    const run = this.db.getAgentRun(params.id);
    if (!run) return null;

    const a2aTask = this.db.getA2ATask(params.id);
    return this.buildTask(run, a2aTask ?? undefined, params.historyLength);
  }

  // ─── tasks/list ────────────────────────────────────────────

  async listTasks(params: TaskListParams): Promise<A2ATask[]> {
    const a2aTasks = this.db.getA2ATasks(params.contextId, params.limit ?? 50, params.offset ?? 0);

    return Promise.all(
      a2aTasks.map(async (a2a) => {
        const run = this.db.getAgentRun(a2a.id);
        return this.buildTask(run!, a2a);
      }),
    );
  }

  // ─── tasks/cancel ──────────────────────────────────────────

  async cancelTask(params: TaskCancelParams): Promise<A2ATask> {
    const run = this.db.getAgentRun(params.id);
    if (!run) throw new TaskNotFoundError(params.id);

    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new TaskNotCancelableError(params.id);
    }

    // Cancel via runtime
    if (this.runtimeRegistry) {
      const agent = this.db.getAgent(run.agent_id);
      if (agent) {
        const runtime = this.runtimeRegistry.resolve(agent);
        await runtime.cancel(params.id);
      }
    }

    this.db.updateAgentRun(params.id, { status: 'cancelled', completed_at: new Date().toISOString() });
    await this.notifyStatusChange(params.id, 'canceled');

    return (await this.getTask({ id: params.id }))!;
  }

  // ─── Push notification config CRUD ─────────────────────────

  async setPushConfig(params: PushNotificationSetParams): Promise<A2APushNotificationConfig> {
    const run = this.db.getAgentRun(params.id);
    if (!run) throw new TaskNotFoundError(params.id);

    const config = params.pushNotificationConfig;
    const id = config.id ?? crypto.randomUUID();

    // Upsert: delete existing with same id, then create
    this.db.deleteA2APushConfig(id);
    this.db.createA2APushConfig({
      id,
      task_id: params.id,
      url: config.url,
      token: config.token,
      authentication: config.authentication ? JSON.stringify(config.authentication) : undefined,
    });

    return { id, url: config.url, token: config.token, authentication: config.authentication };
  }

  async getPushConfig(params: PushNotificationGetParams): Promise<A2APushNotificationConfig[]> {
    const configs = this.db.getA2APushConfigsForTask(params.id);
    return configs.map(c => ({
      id: c.id,
      url: c.url,
      token: c.token ?? undefined,
      authentication: c.authentication ? JSON.parse(c.authentication) : undefined,
    }));
  }

  async deletePushConfig(params: PushNotificationDeleteParams): Promise<void> {
    this.db.deleteA2APushConfig(params.pushNotificationConfigId);
  }

  // ─── SSE Subscriptions ────────────────────────────────────

  subscribe(taskId: string, writer: (event: string) => void): () => void {
    if (!this.subscriptions.has(taskId)) {
      this.subscriptions.set(taskId, new Set());
    }
    this.subscriptions.get(taskId)!.add(writer);

    // Return unsubscribe function
    return () => {
      this.subscriptions.get(taskId)?.delete(writer);
      if (this.subscriptions.get(taskId)?.size === 0) {
        this.subscriptions.delete(taskId);
      }
    };
  }

  // ─── Internal ─────────────────────────────────────────────

  private async executeBlocking(runId: string, agentId: string, text: string, messages: A2AMessage[]): Promise<A2ATask> {
    try {
      this.db.updateAgentRun(runId, { status: 'running', started_at: new Date().toISOString() });
      await this.notifyStatusChange(runId, 'working');

      const result = await this.orchestrator.chat({ text, source: 'a2a', metadata: { agentId } });

      // Append agent response to messages
      const agentMessage: A2AMessage = {
        role: 'agent',
        parts: [{ type: 'text', text: result.text } as TextPart],
      };
      messages.push(agentMessage);

      // Build artifacts from tool calls
      const artifacts = this.buildArtifacts(result.toolCalls);

      const now = new Date().toISOString();
      this.db.updateAgentRun(runId, { status: 'completed', output: JSON.stringify(result), completed_at: now });
      this.db.updateA2ATask(runId, {
        messages: JSON.stringify(messages),
        artifacts: JSON.stringify(artifacts),
      });

      await this.notifyStatusChange(runId, 'completed');
      return (await this.getTask({ id: runId }))!;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.db.updateAgentRun(runId, { status: 'failed', error, completed_at: new Date().toISOString() });
      await this.notifyStatusChange(runId, 'failed');
      return (await this.getTask({ id: runId }))!;
    }
  }

  private async executeBackground(runId: string, agentId: string, text: string): Promise<A2ATask> {
    // Fire and forget via orchestrator.assign
    const taskRef = `a2a:${runId}`;
    try {
      await this.orchestrator.assign(taskRef, agentId, text);
    } catch {
      // assign() itself may throw if task already checked out — fall back to direct execution
      this.runBackgroundDirect(runId, agentId, text);
    }

    await this.notifyStatusChange(runId, 'working');
    return (await this.getTask({ id: runId }))!;
  }

  private async runBackgroundDirect(runId: string, agentId: string, text: string): Promise<void> {
    this.db.updateAgentRun(runId, { status: 'running', started_at: new Date().toISOString() });

    try {
      const result = await this.orchestrator.chat({ text, source: 'a2a', metadata: { agentId } });
      const now = new Date().toISOString();
      this.db.updateAgentRun(runId, { status: 'completed', output: JSON.stringify(result), completed_at: now });

      const artifacts = this.buildArtifacts(result.toolCalls);
      const a2a = this.db.getA2ATask(runId);
      if (a2a) {
        const messages: A2AMessage[] = JSON.parse(a2a.messages);
        messages.push({ role: 'agent', parts: [{ type: 'text', text: result.text } as TextPart] });
        this.db.updateA2ATask(runId, { messages: JSON.stringify(messages), artifacts: JSON.stringify(artifacts) });
      }

      await this.notifyStatusChange(runId, 'completed');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.db.updateAgentRun(runId, { status: 'failed', error, completed_at: new Date().toISOString() });
      await this.notifyStatusChange(runId, 'failed');
    }
  }

  private async resumeTask(taskId: string, message: A2AMessage, text: string): Promise<A2ATask> {
    const run = this.db.getAgentRun(taskId);
    if (!run) throw new TaskNotFoundError(taskId);

    const a2a = this.db.getA2ATask(taskId);
    if (!a2a) throw new TaskNotFoundError(taskId);

    // Append new message
    const messages: A2AMessage[] = JSON.parse(a2a.messages);
    messages.push(message);
    this.db.updateA2ATask(taskId, { messages: JSON.stringify(messages) });

    // Re-execute with full context
    const fullText = messages
      .filter(m => m.role === 'user')
      .map(m => this.extractText(m))
      .join('\n\n');

    return this.executeBlocking(taskId, run.agent_id, fullText, messages);
  }

  private buildTask(run: AgentRunRow, a2aTask?: { messages: string; artifacts: string; context_id: string | null; skill_id: string | null; metadata: string }, historyLength?: number): A2ATask {
    const status: A2ATaskStatus = {
      state: this.mapStatus(run.status),
      timestamp: run.completed_at ?? run.started_at ?? run.created_at,
    };

    // Add agent response as status message if completed
    if (run.status === 'completed' && run.output) {
      try {
        const output = JSON.parse(run.output);
        status.message = {
          role: 'agent',
          parts: [{ type: 'text', text: output.text } as TextPart],
        };
      } catch { /* ignore parse errors */ }
    }

    if (run.status === 'failed' && run.error) {
      status.message = {
        role: 'agent',
        parts: [{ type: 'text', text: `Error: ${run.error}` } as TextPart],
      };
    }

    const task: A2ATask = {
      id: run.id,
      status,
      metadata: a2aTask?.metadata ? JSON.parse(a2aTask.metadata) : undefined,
    };

    if (a2aTask?.context_id) task.contextId = a2aTask.context_id;

    // Include history if requested
    if (a2aTask?.messages) {
      const messages: A2AMessage[] = JSON.parse(a2aTask.messages);
      task.history = historyLength !== undefined ? messages.slice(-historyLength) : messages;
    }

    // Include artifacts
    if (a2aTask?.artifacts) {
      const artifacts: A2AArtifact[] = JSON.parse(a2aTask.artifacts);
      if (artifacts.length > 0) task.artifacts = artifacts;
    }

    return task;
  }

  private mapStatus(runStatus: AgentRunRow['status']): A2ATaskState {
    switch (runStatus) {
      case 'pending': return 'submitted';
      case 'running': return 'working';
      case 'completed': return 'completed';
      case 'failed': return 'failed';
      case 'timeout': return 'failed';
      case 'cancelled': return 'canceled';
      default: return 'submitted';
    }
  }

  private buildArtifacts(toolCalls?: { name: string; input: Record<string, unknown>; output: string }[]): A2AArtifact[] {
    if (!toolCalls?.length) return [];
    return toolCalls.map((tc, i) => ({
      name: tc.name,
      description: `Tool call: ${tc.name}`,
      parts: [{ type: 'data', data: { input: tc.input, output: tc.output } }],
      index: i,
    }));
  }

  private extractText(message: A2AMessage): string {
    return message.parts
      .filter((p): p is TextPart => p.type === 'text')
      .map(p => p.text)
      .join('\n');
  }

  private resolveSkillFromMessage(text: string): string | null {
    // Check for @agent mentions
    const match = text.match(/@(\w+)/);
    if (match) {
      const agents = this.db.getAgents();
      const found = agents.find(a =>
        a.name.toLowerCase().includes(match[1].toLowerCase()) || a.id === match[1],
      );
      if (found) return found.id;
    }
    return null;
  }

  private resolveDefaultAgent(): string {
    const agents = this.db.getAgents().filter(a => a.enabled);
    return agents[0]?.id ?? 'default';
  }

  private resolveRuntimeName(agentId: string): string {
    if (!this.runtimeRegistry) return 'in-process';
    const agent = this.db.getAgent(agentId);
    if (!agent) return 'in-process';
    return this.runtimeRegistry.resolve(agent).name;
  }

  private async notifyStatusChange(taskId: string, state: A2ATaskState): Promise<void> {
    const status: A2ATaskStatus = {
      state,
      timestamp: new Date().toISOString(),
    };

    // Notify SSE subscribers
    const subs = this.subscriptions.get(taskId);
    if (subs?.size) {
      const event = JSON.stringify({
        jsonrpc: '2.0',
        method: 'tasks/status',
        params: { id: taskId, status, final: state === 'completed' || state === 'failed' || state === 'canceled' },
      });
      for (const writer of subs) {
        try { writer(event); } catch { subs.delete(writer); }
      }
      // Clean up if terminal state
      if (state === 'completed' || state === 'failed' || state === 'canceled') {
        this.subscriptions.delete(taskId);
      }
    }

    // Push notifications
    await this.pushNotifier.notify(taskId, { id: taskId, status, final: state === 'completed' || state === 'failed' || state === 'canceled' });
  }
}

// ─── Errors ──────────────────────────────────────────────────

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskNotCancelableError extends Error {
  constructor(taskId: string) {
    super(`Task cannot be canceled: ${taskId}`);
    this.name = 'TaskNotCancelableError';
  }
}
