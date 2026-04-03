// ─── A2A Protocol Types ──────────────────────────────────────
// Based on the Agent-to-Agent (A2A) Protocol Specification
// https://a2a-protocol.org/latest/specification/

// ─── JSON-RPC 2.0 ───────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// Standard JSON-RPC error codes
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // A2A-specific
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  AUTHENTICATION_REQUIRED: -32005,
  CONTENT_TYPE_NOT_SUPPORTED: -32006,
} as const;

// ─── A2A Method Names ────────────────────────────────────────

export type A2AMethod =
  | 'message/send'
  | 'message/stream'
  | 'tasks/get'
  | 'tasks/list'
  | 'tasks/cancel'
  | 'tasks/pushNotificationConfig/set'
  | 'tasks/pushNotificationConfig/get'
  | 'tasks/pushNotificationConfig/list'
  | 'tasks/pushNotificationConfig/delete'
  | 'agent/authenticatedExtendedCard';

// ─── Parts (content units) ───────────────────────────────────

export interface TextPart {
  type: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface FilePart {
  type: 'file';
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string;   // base64 encoded
    uri?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface DataPart {
  type: 'data';
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

// ─── Messages ────────────────────────────────────────────────

export interface A2AMessage {
  role: 'user' | 'agent';
  parts: Part[];
  metadata?: Record<string, unknown>;
}

// ─── Artifacts ───────────────────────────────────────────────

export interface A2AArtifact {
  name?: string;
  description?: string;
  parts: Part[];
  index: number;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

// ─── Task ────────────────────────────────────────────────────

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp: string;
}

export interface A2ATask {
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

// ─── Push Notifications ──────────────────────────────────────

export interface A2APushNotificationConfig {
  id: string;
  url: string;
  token?: string;
  authentication?: {
    schemes: string[];
    credentials?: string;
  };
}

// ─── Agent Card ──────────────────────────────────────────────

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

export interface A2AAgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: A2AAgentCapabilities;
  authentication: {
    schemes: string[];
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
}

// ─── Method Params ───────────────────────────────────────────

export interface MessageSendParams {
  message: A2AMessage;
  configuration?: {
    acceptedOutputModes?: string[];
    historyLength?: number;
    pushNotificationConfig?: A2APushNotificationConfig;
    blocking?: boolean;
  };
  metadata?: Record<string, unknown>;
  // If resuming an existing task
  taskId?: string;
  // Contextual grouping
  contextId?: string;
  // Target a specific skill/agent
  skillId?: string;
}

export interface TaskGetParams {
  id: string;
  historyLength?: number;
}

export interface TaskListParams {
  contextId?: string;
  limit?: number;
  offset?: number;
}

export interface TaskCancelParams {
  id: string;
}

export interface PushNotificationSetParams {
  id: string;  // task ID
  pushNotificationConfig: A2APushNotificationConfig;
}

export interface PushNotificationGetParams {
  id: string;  // task ID
}

export interface PushNotificationListParams {
  id: string;  // task ID
}

export interface PushNotificationDeleteParams {
  id: string;  // task ID
  pushNotificationConfigId: string;
}

// ─── SSE Events ──────────────────────────────────────────────

export interface TaskStatusUpdateEvent {
  id: string;
  status: A2ATaskStatus;
  final: boolean;
}

export interface TaskArtifactUpdateEvent {
  id: string;
  artifact: A2AArtifact;
}

// ─── DB Row Types ────────────────────────────────────────────

export interface A2ATaskRow {
  id: string;
  context_id: string | null;
  skill_id: string | null;
  messages: string;     // JSON
  artifacts: string;    // JSON
  metadata: string;     // JSON
  created_at: string;
  updated_at: string;
}

export interface A2APushConfigRow {
  id: string;
  task_id: string;
  url: string;
  token: string | null;
  authentication: string | null; // JSON
  created_at: string;
}
