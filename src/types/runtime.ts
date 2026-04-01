import type { AgentInput, AgentOutput, AgentRow } from './index.js';

// ─── Agent Runtime Interface ─────────────────────────────────

export interface AgentRuntime {
  readonly name: string;
  execute(params: AgentExecutionParams): Promise<AgentExecutionHandle>;
  status(runId: string): Promise<AgentRunStatus>;
  cancel(runId: string): Promise<void>;
  logs(runId: string): AsyncIterable<string>;
}

// ─── Execution Parameters ────────────────────────────────────

export interface AgentExecutionParams {
  agentId: string;
  input: AgentInput;
  config: AgentRow;
  mcpServers: McpServerRef[];
  timeout?: number;         // wall-clock ms, default 5 min
  resources?: ResourceLimits;
  userId?: string;          // for governance context
}

export interface McpServerRef {
  serverId: string;
  connectionId?: string;    // for governed servers
}

export interface ResourceLimits {
  maxMemoryMb?: number;     // default 512
  maxCpuShares?: number;    // default 1024 (1 core)
  maxDiskMb?: number;       // default 256
}

// ─── Execution Handle ────────────────────────────────────────

export interface AgentExecutionHandle {
  runId: string;
  stream: AsyncIterable<AgentStreamEvent>;
  result: Promise<AgentOutput>;
}

// ─── Run Status ──────────────────────────────────────────────

export type AgentRunStatus =
  | { state: 'pending' }
  | { state: 'running'; startedAt: Date; turns: number }
  | { state: 'completed'; result: AgentOutput; durationMs: number }
  | { state: 'failed'; error: string; durationMs: number }
  | { state: 'cancelled'; durationMs: number }
  | { state: 'timeout'; partialResult?: AgentOutput; durationMs: number };

// ─── Stream Events ───────────────────────────────────────────

export interface AgentStreamEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'status';
  data: unknown;
  timestamp: number;
}

// ─── Run Record (DB) ─────────────────────────────────────────

export interface AgentRunRow {
  id: string;
  agent_id: string;
  runtime: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  input: string;            // JSON
  output: string | null;    // JSON
  container_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  error: string | null;
  resource_usage: string | null; // JSON: { peakMemoryMb, cpuSeconds }
  created_at: string;
}

// ─── Runtime Config ──────────────────────────────────────────

export type RuntimeType = 'in-process' | 'docker' | 'agent-os' | 'remote';

export interface DockerRuntimeConfig {
  image?: string;           // default: built from nix flake
  hostCallbackPort?: number; // port for agent→host communication
  network?: string;         // docker network name
}
