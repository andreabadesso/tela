/**
 * Agent Worker — standalone entrypoint for containerized agent runs.
 *
 * This process is the container's main command. It:
 * 1. Reads execution params from environment variables
 * 2. Connects to host MCP proxy for tool access
 * 3. Runs query() from claude-agent-sdk
 * 4. Streams events back to host via callback URL
 * 5. Posts final result and exits
 *
 * Environment variables (set by DockerRuntime):
 *   AGENT_RUN_ID        — unique run identifier
 *   AGENT_ID            — agent to execute
 *   AGENT_INPUT         — JSON-encoded AgentInput
 *   AGENT_CONFIG        — JSON-encoded AgentRow
 *   AGENT_MCP_SERVERS   — JSON-encoded McpServerRef[]
 *   AGENT_TIMEOUT       — wall-clock timeout in ms
 *   AGENT_USER_ID       — user context for governance (optional)
 *   CALLBACK_URL        — URL to POST result back to host
 *   MCP_PROXY_URL       — base URL for MCP proxy on host
 */

import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

interface WorkerConfig {
  runId: string;
  agentId: string;
  input: { text: string; source: string; userId?: string; metadata?: Record<string, unknown> };
  agentConfig: {
    model: string;
    system_prompt: string;
    max_turns: number;
    name: string;
  };
  mcpServers: Array<{ serverId: string; connectionId?: string }>;
  timeout: number;
  userId?: string;
  callbackUrl: string;
  mcpProxyUrl: string;
}

function loadConfig(): WorkerConfig {
  const required = (name: string): string => {
    const val = process.env[name];
    if (!val) throw new Error(`Missing env: ${name}`);
    return val;
  };

  return {
    runId: required('AGENT_RUN_ID'),
    agentId: required('AGENT_ID'),
    input: JSON.parse(required('AGENT_INPUT')),
    agentConfig: JSON.parse(required('AGENT_CONFIG')),
    mcpServers: JSON.parse(required('AGENT_MCP_SERVERS')),
    timeout: parseInt(process.env.AGENT_TIMEOUT ?? '300000', 10),
    userId: process.env.AGENT_USER_ID,
    callbackUrl: required('CALLBACK_URL'),
    mcpProxyUrl: required('MCP_PROXY_URL'),
  };
}

/**
 * Build an MCP server that proxies tool calls back to the host.
 * Each tool call goes through the governance layer on the host side.
 */
function buildProxyMcpServer(config: WorkerConfig) {
  const proxyTool = tool(
    'mcp_proxy_call',
    'Execute a tool call through the host MCP proxy. All tool access is governed by the host.',
    {
      serverId: z.string().describe('MCP server ID to call'),
      toolName: z.string().describe('Tool name to invoke'),
      params: z.record(z.unknown()).optional().describe('Tool parameters'),
    },
    async (args) => {
      const response = await fetch(`${config.mcpProxyUrl}/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Run-Id': config.runId,
          ...(config.userId ? { 'X-User-Id': config.userId } : {}),
        },
        body: JSON.stringify({
          serverId: args.serverId,
          method: args.toolName,
          params: args.params ?? {},
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return { content: [{ type: 'text' as const, text: `MCP proxy error: ${err}` }] };
      }

      const result = await response.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  return createSdkMcpServer({
    name: 'host-proxy',
    version: '1.0.0',
    tools: [proxyTool],
  });
}

async function postEvent(callbackUrl: string, runId: string, event: { type: string; data: unknown }) {
  try {
    await fetch(callbackUrl.replace('/result', '/event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Run-Id': runId },
      body: JSON.stringify(event),
    });
  } catch {
    // Best effort — don't crash if host is slow
  }
}

async function postResult(callbackUrl: string, runId: string, result: { text: string; error?: string }) {
  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Run-Id': runId },
    body: JSON.stringify(result),
  });
  if (!response.ok) {
    console.error(`[agent-worker] Failed to post result: ${response.status} ${await response.text()}`);
  }
}

async function main() {
  const config = loadConfig();

  console.log(`[agent-worker] Starting run ${config.runId} for agent ${config.agentId}`);
  console.log(`[agent-worker] Timeout: ${config.timeout}ms, MCP servers: ${config.mcpServers.length}`);

  // Set up wall-clock timeout
  const timer = setTimeout(() => {
    console.error(`[agent-worker] Timed out after ${config.timeout}ms`);
    process.exit(124); // timeout exit code
  }, config.timeout);

  try {
    // Build proxy MCP server for host communication
    const proxyServer = buildProxyMcpServer(config);

    // Build system prompt
    const today = new Date().toLocaleDateString('pt-BR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const systemPrompt = [
      config.agentConfig.system_prompt,
      `Today is ${today}.`,
      'Respond in Portuguese (BR) unless the message is in English.',
    ].join('\n');

    let resultText = '';

    // Execute agent query
    for await (const message of query({
      prompt: config.input.text,
      options: {
        systemPrompt,
        model: config.agentConfig.model,
        maxTurns: config.agentConfig.max_turns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        mcpServers: { 'host-proxy': proxyServer },
      },
    })) {
      if ('result' in message) {
        resultText = message.result ?? '';
      }
      // Stream events back to host
      await postEvent(config.callbackUrl, config.runId, {
        type: 'result' in message ? 'text' : 'status',
        data: message,
      });
    }

    // Post final result
    await postResult(config.callbackUrl, config.runId, { text: resultText });
    console.log(`[agent-worker] Run ${config.runId} completed successfully`);

    clearTimeout(timer);
    process.exit(0);
  } catch (err) {
    clearTimeout(timer);
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[agent-worker] Run ${config.runId} failed:`, errorMessage);

    // Report error back to host
    await postResult(config.callbackUrl, config.runId, {
      text: 'Agent execution failed.',
      error: errorMessage,
    }).catch(() => {});

    process.exit(1);
  }
}

main();
