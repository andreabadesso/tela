import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DatabaseService } from '../../core/database.js';
import type { AgentService } from '../../agent/service.js';
import type { Orchestrator } from '../../orchestrator/index.js';
import type { AuthUser } from '../middleware.js';

export function chatRoutes(deps: {
  agentService: AgentService;
  orchestrator?: Orchestrator;
  db: DatabaseService;
}) {
  const app = new Hono();

  // SSE streaming chat endpoint — streams AgentStreamEvents in real-time
  app.post('/chat', async (c) => {
    const body = await c.req.json<{ text: string; agentId?: string }>();
    if (!body.text) {
      return c.json({ error: 'Missing "text" field' }, 400);
    }

    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    const userId = user?.id;

    return streamSSE(c, async (stream) => {
      const abortController = new AbortController();

      // Abort agent loop when client disconnects
      stream.onAbort(() => {
        abortController.abort();
      });

      try {
        const input = {
          text: body.text,
          source: 'web' as const,
          userId,
          metadata: body.agentId ? { agentId: body.agentId } : undefined,
        };

        let eventStream: AsyncIterable<import('../../types/runtime.js').AgentStreamEvent>;

        if (deps.orchestrator) {
          eventStream = deps.orchestrator.chatStream(input, abortController.signal);
        } else {
          const agents = deps.db.getAgents();
          const agentId = body.agentId ?? agents.find((a) => a.enabled)?.id ?? '';
          eventStream = deps.agentService.processStream(agentId, input, undefined, abortController.signal);
        }

        for await (const event of eventStream) {
          if (abortController.signal.aborted) break;
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ type: 'error', message, timestamp: Date.now() }),
        });
      }
    });
  });

  return app;
}
