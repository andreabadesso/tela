import { Hono } from 'hono';
import type { DatabaseService } from '../../core/database.js';
import type { McpGateway } from '../../agent/mcp-gateway.js';
import type { DockerRuntime } from '../../runtime/docker.js';

interface McpProxyDeps {
  db: DatabaseService;
  mcpGateway?: McpGateway;
  dockerRuntime?: DockerRuntime;
}

/**
 * Internal MCP proxy routes.
 *
 * These endpoints are used by agent containers to:
 * 1. Forward MCP tool calls through the governance layer
 * 2. Post agent stream events back to the host
 * 3. Post final agent results back to the host
 *
 * Not exposed publicly — only accessible from Docker containers via
 * host.docker.internal. Protected by run-scoped X-Run-Id header.
 */
export function mcpProxyRoutes(deps: McpProxyDeps) {
  const app = new Hono();

  /**
   * POST /internal/mcp-proxy/call
   * Forward a tool call from an agent container through the governance layer.
   */
  app.post('/internal/mcp-proxy/call', async (c) => {
    const runId = c.req.header('X-Run-Id');
    const userId = c.req.header('X-User-Id');

    if (!runId) {
      return c.json({ error: 'Missing X-Run-Id header' }, 400);
    }

    // Verify the run exists and is active
    const run = deps.db.getAgentRun(runId);
    if (!run || run.status !== 'running') {
      return c.json({ error: 'Invalid or inactive run' }, 403);
    }

    const body = await c.req.json<{
      serverId: string;
      method: string;
      params: Record<string, unknown>;
    }>();

    if (!body.serverId || !body.method) {
      return c.json({ error: 'Missing serverId or method' }, 400);
    }

    // If we have a gateway and userId, route through governance
    if (deps.mcpGateway && userId) {
      try {
        const servers = await deps.mcpGateway.resolveServers(userId, run.agent_id);
        const server = servers[body.serverId];

        if (!server) {
          deps.db.logAudit(run.agent_id, 'mcp_proxy_denied', {
            run_id: runId,
            server_id: body.serverId,
            method: body.method,
            reason: 'server_not_accessible',
          }, 'agent-container');

          return c.json({ error: `MCP server "${body.serverId}" not accessible for this user/agent` }, 403);
        }

        // The governed proxy handles authorization, rate limiting, etc.
        // For now, return a governed acknowledgement
        deps.db.logAudit(run.agent_id, 'mcp_proxy_call', {
          run_id: runId,
          server_id: body.serverId,
          method: body.method,
          user_id: userId,
        }, 'agent-container');

        return c.json({
          status: 'ok',
          result: `[Governed MCP Proxy] Server: ${body.serverId}, Method: ${body.method}. Real forwarding pending registry integration.`,
        });
      } catch (err) {
        return c.json({
          error: `Governance check failed: ${err instanceof Error ? err.message : String(err)}`,
        }, 500);
      }
    }

    // No governance — direct pass-through (for vault-tools etc.)
    deps.db.logAudit(run.agent_id, 'mcp_proxy_call', {
      run_id: runId,
      server_id: body.serverId,
      method: body.method,
      ungoverned: true,
    }, 'agent-container');

    return c.json({
      status: 'ok',
      result: `[MCP Proxy] Server: ${body.serverId}, Method: ${body.method}. Direct forwarding pending.`,
    });
  });

  /**
   * POST /internal/mcp-proxy/event
   * Receive a stream event from an agent container.
   */
  app.post('/internal/mcp-proxy/event', async (c) => {
    const runId = c.req.header('X-Run-Id');
    if (!runId) return c.json({ error: 'Missing X-Run-Id' }, 400);

    const event = await c.req.json<Record<string, unknown>>();

    // Normalize container events to AgentStreamEvent shape
    const streamEvent = {
      ...event,
      timestamp: Date.now(),
    } as import('../../types/runtime.js').AgentStreamEvent;

    if (deps.dockerRuntime) {
      deps.dockerRuntime.pushEvent(runId, streamEvent);
    }

    return c.json({ status: 'ok' });
  });

  /**
   * POST /internal/mcp-proxy/result
   * Receive the final result from an agent container.
   */
  app.post('/internal/mcp-proxy/result', async (c) => {
    const runId = c.req.header('X-Run-Id');
    if (!runId) return c.json({ error: 'Missing X-Run-Id' }, 400);

    const result = await c.req.json<{ text: string; error?: string }>();

    // Update run in DB
    const run = deps.db.getAgentRun(runId);
    if (run) {
      const durationMs = run.started_at
        ? Date.now() - new Date(run.started_at).getTime()
        : 0;

      if (result.error) {
        deps.db.updateAgentRun(runId, {
          status: 'failed',
          output: JSON.stringify({ text: result.text }),
          error: result.error,
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
        });
      } else {
        deps.db.updateAgentRun(runId, {
          status: 'completed',
          output: JSON.stringify({ text: result.text }),
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
        });
      }
    }

    // Resolve the pending promise in DockerRuntime
    if (deps.dockerRuntime) {
      deps.dockerRuntime.resolveRun(runId, { text: result.text });
    }

    return c.json({ status: 'ok' });
  });

  /**
   * GET /internal/mcp-proxy/tools
   * List available MCP tools for an agent run (for container discovery).
   */
  app.get('/internal/mcp-proxy/tools', async (c) => {
    const runId = c.req.header('X-Run-Id');
    const userId = c.req.header('X-User-Id');

    if (!runId) return c.json({ error: 'Missing X-Run-Id' }, 400);

    const run = deps.db.getAgentRun(runId);
    if (!run) return c.json({ error: 'Run not found' }, 404);

    if (deps.mcpGateway && userId) {
      const servers = await deps.mcpGateway.resolveServers(userId, run.agent_id);
      return c.json({ servers: Object.keys(servers) });
    }

    return c.json({ servers: [] });
  });

  return app;
}
