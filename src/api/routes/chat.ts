import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { CtoAgent } from '../../agent.js';
import type { DatabaseService } from '../../services/database.js';
import type { AgentService } from '../../services/agent-service.js';
import type { Orchestrator } from '../../orchestrator/index.js';
import type { AuthUser } from '../middleware.js';

export function chatRoutes(deps: {
  agent: CtoAgent;
  agentService?: AgentService;
  orchestrator?: Orchestrator;
  db: DatabaseService;
}) {
  const app = new Hono();

  // SSE streaming chat endpoint
  app.post('/chat', async (c) => {
    const body = await c.req.json<{ text: string; agentId?: string }>();
    if (!body.text) {
      return c.json({ error: 'Missing "text" field' }, 400);
    }

    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    const userId = user?.id;

    return streamSSE(c, async (stream) => {
      const startTime = Date.now();

      // Send thinking event immediately
      await stream.writeSSE({ event: 'thinking', data: '{}' });

      try {
        let response;

        if (deps.orchestrator) {
          response = await deps.orchestrator.chat({
            text: body.text,
            source: 'web',
            userId,
            metadata: body.agentId ? { agentId: body.agentId } : undefined,
          });
        } else if (body.agentId && deps.agentService) {
          response = await deps.agentService.process(body.agentId, {
            text: body.text,
            source: 'web',
            userId,
          });
        } else {
          response = await deps.agent.process({
            text: body.text,
            source: 'web',
          });
        }

        // Send the full text
        await stream.writeSSE({
          event: 'text',
          data: JSON.stringify({ text: response.text }),
        });

        // Send tool calls if any
        if (response.toolCalls?.length) {
          await stream.writeSSE({
            event: 'tool_calls',
            data: JSON.stringify({ toolCalls: response.toolCalls }),
          });
        }

        // Send done
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ durationMs: Date.now() - startTime }),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: message }),
        });
      }
    });
  });

  return app;
}
