import type { A2ATaskManager } from './task-manager.js';

/**
 * Bridges A2A task subscriptions to SSE (Server-Sent Events) responses.
 *
 * The A2A spec requires SSE for streaming — each event is a JSON-RPC notification:
 *   data: {"jsonrpc":"2.0","method":"tasks/status","params":{...}}
 */
export function createSSEStream(
  taskId: string,
  taskManager: A2ATaskManager,
): { readable: ReadableStream; cleanup: () => void } {
  let unsubscribe: (() => void) | null = null;

  const readable = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const writer = (event: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        } catch {
          // Stream closed
          unsubscribe?.();
        }
      };

      unsubscribe = taskManager.subscribe(taskId, writer);
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return {
    readable,
    cleanup: () => unsubscribe?.(),
  };
}

/**
 * Handles a message/stream request: sends the message, then streams
 * status updates via SSE until the task reaches a terminal state.
 */
export async function handleStreamingMessage(
  taskManager: A2ATaskManager,
  params: Parameters<A2ATaskManager['sendMessage']>[0],
): Promise<{ readable: ReadableStream; taskId: string }> {
  // Override to non-blocking so we get status updates
  params.configuration = { ...params.configuration, blocking: false };

  const task = await taskManager.sendMessage(params);
  const { readable, cleanup } = createSSEStream(task.id, taskManager);

  // Send initial task state as first SSE event
  const encoder = new TextEncoder();
  const initialEvent = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tasks/status',
    params: {
      id: task.id,
      status: task.status,
      final: false,
    },
  });

  const wrappedReadable = new ReadableStream({
    async start(controller) {
      // Send initial state
      controller.enqueue(encoder.encode(`data: ${initialEvent}\n\n`));

      // Pipe the subscription stream
      const reader = readable.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);

          // Check if this was a terminal event
          const text = new TextDecoder().decode(value);
          if (text.includes('"final":true')) {
            break;
          }
        }
      } catch {
        // Stream error
      } finally {
        reader.releaseLock();
        cleanup();
        controller.close();
      }
    },
    cancel() {
      cleanup();
    },
  });

  return { readable: wrappedReadable, taskId: task.id };
}
