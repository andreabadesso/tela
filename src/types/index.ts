export interface AgentInput {
  text: string;
  source: 'telegram' | 'cron' | 'event' | 'web' | 'agent';
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentOutput {
  text: string;
  toolCalls?: ToolCallRecord[];
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  output: string;
}

export interface SearchResult {
  file: string;
  line: number;
  content: string;
  context: string[];
}

export interface Task {
  text: string;
  done: boolean;
  file: string;
  line: number;
}

export interface Section {
  title: string;
  items: string[];
}

export interface JobDefinition {
  name: string;
  schedule: string;
  handler: () => Promise<string>;
  channel: 'telegram';
  enabled: boolean;
}

export interface ConversationRow {
  id: number;
  timestamp: string;
  source: string;
  input: string;
  output: string;
  tool_calls: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  duration_ms: number | null;
}

export interface JobRunRow {
  id: number;
  job_name: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'error';
  output: string | null;
  error: string | null;
  consecutive_failures: number;
}

export interface EodStateRow {
  date: string;
  prompted_at: string | null;
  response_received_at: string | null;
  response: string | null;
  processed_at: string | null;
  updates_made: string | null;
}

export interface AgentRow {
  id: string;
  name: string;
  model: string;
  system_prompt: string;
  mcp_servers: string; // JSON
  knowledge_sources: string; // JSON
  permissions: string; // JSON
  max_turns: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ConnectionRow {
  id: string;
  name: string;
  type: string;
  status: string;
  config: string;
  credentials: string | null;
  mcp_server_url: string | null;
  token_strategy: 'company' | 'team' | 'user';
  team_id: string | null;
  last_sync_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleRow {
  id: string;
  name: string;
  cron_expression: string;
  agent_id: string;
  prompt: string;
  notification_channels: string;
  enabled: number;
  last_run_at: string | null;
  last_result: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSourceRow {
  id: string;
  name: string;
  type: string;
  config: string;
  status: string;
  last_sync_at: string | null;
  doc_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditLogRow {
  id: number;
  agent_id: string | null;
  action: string;
  details: string;
  source: string;
  duration_ms: number | null;
  created_at: string;
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
}

export interface NotificationChannelRow {
  id: string;
  type: string;
  name: string;
  config: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface TaskCheckoutRow {
  id: string;
  task_ref: string;
  agent_id: string;
  run_id: string;
  session_id: string | null;
  checked_out_at: string;
  released_at: string | null;
  status: 'active' | 'completed' | 'cancelled';
}

export interface CostEventRow {
  id: number;
  agent_id: string;
  run_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  created_at: string;
}

export interface BudgetPolicyRow {
  id: string;
  scope: string;
  scope_id: string | null;
  monthly_limit_cents: number;
  soft_threshold_pct: number;
  hard_threshold_pct: number;
  action_on_hard: string;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  agent_id: string;
  type: string;
  status: 'pending' | 'approved' | 'rejected';
  context: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

// ─── Auth & RBAC ──────────────────────────────────────────────

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  status: 'active' | 'suspended' | 'deactivated';
  created_at: string;
  updated_at: string;
}

export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  is_system: number;
  created_at: string;
}

export interface TeamRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface UserApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

// ─── Governance ───────────────────────────────────────────────

export interface McpPolicyRow {
  id: string;
  principal_type: string;
  principal_id: string;
  connection_id: string;
  access_level: string;
  allowed_tools: string | null;
  denied_tools: string | null;
  max_data_classification: string;
  rate_limit_per_hour: number | null;
  rate_limit_per_day: number | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgePolicyRow {
  id: string;
  principal_type: string;
  principal_id: string;
  knowledge_source_id: string;
  access_level: string;
  created_at: string;
}

export interface AgentPolicyRow {
  id: string;
  principal_type: string;
  principal_id: string;
  agent_id: string;
  can_use: number;
  can_configure: number;
  created_at: string;
}

export interface UserConnectionRow {
  id: string;
  user_id: string;
  connection_id: string;
  credentials: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpToolClassificationRow {
  id: string;
  connection_id: string;
  tool_name: string;
  data_classification: string;
  description: string | null;
}
