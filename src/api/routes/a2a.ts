import { Hono } from 'hono';
import type { Context } from 'hono';
import type { A2ATaskManager } from '../../a2a/task-manager.js';
import { TaskNotFoundError, TaskNotCancelableError } from '../../a2a/task-manager.js';
import { generateAgentCard, generateExtendedAgentCard } from '../../a2a/agent-card.js';
import { handleStreamingMessage } from '../../a2a/sse-bridge.js';
import type { DatabaseService } from '../../core/database.js';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  MessageSendParams,
  TaskGetParams,
  TaskListParams,
  TaskCancelParams,
  PushNotificationSetParams,
  PushNotificationGetParams,
  PushNotificationDeleteParams,
} from '../../a2a/types.js';
import { JSON_RPC_ERRORS } from '../../a2a/types.js';

interface A2ARouteDeps {
  db: DatabaseService;
  taskManager: A2ATaskManager;
  baseUrl: string;
}

export function a2aRoutes(deps: A2ARouteDeps) {
  const app = new Hono();

  // ─── Agent Card (public, no auth) ─────────────────────────

  app.get('/.well-known/agent.json', (c) => {
    const card = generateAgentCard(deps.db, deps.baseUrl);
    return c.json(card);
  });

  // ─── JSON-RPC 2.0 Endpoint ────────────────────────────────

  app.post('/a2a', async (c) => {
    // Parse JSON-RPC request
    let request: JsonRpcRequest;
    try {
      request = await c.req.json<JsonRpcRequest>();
    } catch {
      return c.json(rpcError(null, JSON_RPC_ERRORS.PARSE_ERROR, 'Parse error'), 200);
    }

    if (!request.jsonrpc || request.jsonrpc !== '2.0' || !request.method) {
      return c.json(rpcError(request.id ?? null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC request'), 200);
    }

    // Route to method handler
    try {
      switch (request.method) {
        case 'message/send':
          return await handleMessageSend(c, deps, request);

        case 'message/stream':
          return await handleMessageStream(c, deps, request);

        case 'tasks/get':
          return await handleTasksGet(c, deps, request);

        case 'tasks/list':
          return await handleTasksList(c, deps, request);

        case 'tasks/cancel':
          return await handleTasksCancel(c, deps, request);

        case 'tasks/pushNotificationConfig/set':
          return await handlePushSet(c, deps, request);

        case 'tasks/pushNotificationConfig/get':
          return await handlePushGet(c, deps, request);

        case 'tasks/pushNotificationConfig/delete':
          return await handlePushDelete(c, deps, request);

        case 'agent/authenticatedExtendedCard':
          return handleExtendedCard(c, deps, request);

        default:
          return c.json(rpcError(request.id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${request.method}`), 200);
      }
    } catch (err) {
      return handleRpcError(c, request.id, err);
    }
  });

  return app;
}

// ─── Method Handlers ─────────────────────────────────────────

async function handleMessageSend(c: Context, deps: A2ARouteDeps, request: JsonRpcRequest) {
  const params = request.params as unknown as MessageSendParams;
  if (!params?.message) {
    return c.json(rpcError(request.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'Missing required param: message'), 200);
  }

  const task = await deps.taskManager.sendMessage(params);
  return c.json(rpcSuccess(request.id, task), 200);
}

async function handleMessageStream(c: Context, deps: A2ARouteDeps, request: JsonRpcRequest) {
  const params = request.params as unknown as MessageSendParams;
  if (!params?.message) {
    return c.json(rpcError(request.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'Missing required param: message'), 200);
  }

  const { readable } = await handleStreamingMessage(deps.taskManager, params);

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Request-Id': String(request.id),
    },
  });
}

async function handleTasksGet(c: Context, deps: A2ARouteDeps, request: JsonRpcRequest) {
  const params = request.params as unknown as TaskGetParams;
  if (!params?.id) {
    return c.json(rpcError(request.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'Missing required param: id'), 200);
  }

  const task = await deps.taskManager.getTask(params);
  if (!task) {
    return c.json(rpcError(request.id, JSON_RPC_ERRORS.TASK_NOT_FOUND, `Task not found: ${params.id}`), 200);
  }

  return c.json(rpcSuccess(request.id, task), 200);
}

async function handleTasksList(c: Context, deps: A2ARouteDeps, request: JsonRpcRequest) {
  const params = (request.params ?? {}) as unknown as TaskListParams;
  const tasks = await deps.taskManager.listTasks(params);
  return c.json(rpcSuccess(request.id, tasks), 200);
}

async function handleTasksCancel(c: Context, deps: A2ARouteDeps, request: JsonRpcRequest) {
  const params = request.params as unknown as TaskCancelParams;
  if (!params?.id) {
    return c.json(rpcError(request.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'Missing required param: id'), 200);
  }

  const task = await deps.taskManager.cancelTask(params);
  return c.json(rpcSuccess(request.id, task), 200);
}

async function handlePushSet(c: Context, deps: A2ARouteDeps, request: JsonRpcRequest) {
  const params = request.params as unknown as PushNotificationSetParams;
  if (!params?.id || !params?.pushNotificationConfig) {
    return c.json(rpcError(request.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'Missing required params: id, pushNotificationConfig'), 200);
  }

  const config = await deps.taskManager.setPushConfig(params);
  return c.json(rpcSuccess(request.id, config), 200);
}

async function handlePushGet(c: Context, deps: A2ARouteDeps, request: JsonRpcRequest) {
  const params = request.params as unknown as PushNotificationGetParams;
  if (!params?.id) {
    return c.json(rpcError(request.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'Missing required param: id'), 200);
  }

  const configs = await deps.taskManager.getPushConfig(params);
  return c.json(rpcSuccess(request.id, configs), 200);
}

async function handlePushDelete(c: Context, deps: A2ARouteDeps, request: JsonRpcRequest) {
  const params = request.params as unknown as PushNotificationDeleteParams;
  if (!params?.id || !params?.pushNotificationConfigId) {
    return c.json(rpcError(request.id, JSON_RPC_ERRORS.INVALID_PARAMS, 'Missing required params: id, pushNotificationConfigId'), 200);
  }

  await deps.taskManager.deletePushConfig(params);
  return c.json(rpcSuccess(request.id, null), 200);
}

function handleExtendedCard(c: Context, deps: A2ARouteDeps, request: JsonRpcRequest) {
  const card = generateExtendedAgentCard(deps.db, deps.baseUrl);
  return c.json(rpcSuccess(request.id, card), 200);
}

// ─── JSON-RPC Helpers ────────────────────────────────────────

function rpcSuccess(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? 0, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? 0, error };
}

function handleRpcError(c: Context, id: string | number, err: unknown) {
  if (err instanceof TaskNotFoundError) {
    return c.json(rpcError(id, JSON_RPC_ERRORS.TASK_NOT_FOUND, err.message), 200);
  }
  if (err instanceof TaskNotCancelableError) {
    return c.json(rpcError(id, JSON_RPC_ERRORS.TASK_NOT_CANCELABLE, err.message), 200);
  }

  const message = err instanceof Error ? err.message : 'Internal error';
  console.error('[a2a] Error handling request:', message);
  return c.json(rpcError(id, JSON_RPC_ERRORS.INTERNAL_ERROR, message), 200);
}
