import { Hono } from 'hono';
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

  // Send message to agent
  app.post('/chat', async (c) => {
    const body = await c.req.json<{ text: string; agentId?: string }>();
    if (!body.text) {
      return c.json({ error: 'Missing "text" field' }, 400);
    }

    const startTime = Date.now();
    const user = (c as unknown as { get(key: 'user'): AuthUser | undefined }).get('user');
    const userId = user?.id;

    // If orchestrator is available, use it for routing
    if (deps.orchestrator) {
      try {
        const response = await deps.orchestrator.chat({
          text: body.text,
          source: 'web',
          userId,
          metadata: body.agentId ? { agentId: body.agentId } : undefined,
        });
        return c.json({
          text: response.text,
          toolCalls: response.toolCalls ?? [],
          durationMs: Date.now() - startTime,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return c.json({ error: message }, 400);
      }
    }

    // Fallback: If agentId is specified and AgentService is available, use it
    if (body.agentId && deps.agentService) {
      try {
        const response = await deps.agentService.process(body.agentId, {
          text: body.text,
          source: 'web',
          userId,
        });
        return c.json({
          text: response.text,
          toolCalls: response.toolCalls ?? [],
          durationMs: Date.now() - startTime,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return c.json({ error: message }, 400);
      }
    }

    // Default: use the CtoAgent directly
    const response = await deps.agent.process({
      text: body.text,
      source: 'web',
    });

    return c.json({
      text: response.text,
      toolCalls: response.toolCalls ?? [],
      durationMs: Date.now() - startTime,
    });
  });

  return app;
}
