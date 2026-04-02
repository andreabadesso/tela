import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { z } from 'zod';
import type { DatabaseService } from '../core/database.js';
import type { EncryptionService } from '../core/encryption.js';
import type { McpPolicyRow, ConnectionRow } from '../types/index.js';
import { config } from '../config/env.js';

// Data classification hierarchy (higher index = more restricted)
const CLASSIFICATION_LEVELS = ['public', 'internal', 'confidential', 'restricted'] as const;
type DataClassification = (typeof CLASSIFICATION_LEVELS)[number];

function classificationLevel(c: string): number {
  return CLASSIFICATION_LEVELS.indexOf(c as DataClassification);
}

function isClassificationAllowed(toolClassification: string, maxAllowed: string): boolean {
  const toolLevel = classificationLevel(toolClassification);
  const maxLevel = classificationLevel(maxAllowed);
  if (toolLevel === -1 || maxLevel === -1) return true; // unknown classifications pass through
  return toolLevel <= maxLevel;
}

interface McpClientEntry {
  client: Client;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  connectedAt: number;
}

export class McpGateway {
  private rateLimiter = new RateLimiter();
  private clientPool = new Map<string, McpClientEntry>();

  constructor(
    private db: DatabaseService,
    private encryption: EncryptionService,
  ) {}

  /**
   * Connect to a remote MCP server and cache the client + discovered tools.
   */
  private async getOrCreateClient(connectionId: string, url: string, token: string): Promise<McpClientEntry> {
    const existing = this.clientPool.get(connectionId);
    // Reuse cached client if it's less than 5 minutes old
    if (existing && (Date.now() - existing.connectedAt) < 5 * 60_000) return existing;
    // Evict stale client
    if (existing) {
      try { await existing.client.close(); } catch { /* ignore */ }
      this.clientPool.delete(connectionId);
    }

    const client = new Client({ name: 'tela-gateway', version: '1.0.0' });
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const transport = new SSEClientTransport(new URL(url), { requestInit: { headers } });

    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools = toolsResult.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));

    const entry: McpClientEntry = { client, tools, connectedAt: Date.now() };
    this.clientPool.set(connectionId, entry);

    console.log(`[mcp-gateway] Connected to ${connectionId}: ${tools.length} tools discovered`);
    return entry;
  }

  /**
   * Disconnect a cached client (e.g. on credential change or error).
   */
  async disconnectClient(connectionId: string): Promise<void> {
    const entry = this.clientPool.get(connectionId);
    if (entry) {
      try { await entry.client.close(); } catch { /* ignore */ }
      this.clientPool.delete(connectionId);
    }
  }

  /**
   * Disconnect all cached clients (for graceful shutdown).
   */
  async disconnectAll(): Promise<void> {
    for (const [id] of this.clientPool) {
      await this.disconnectClient(id);
    }
  }

  /**
   * Resolve the governed MCP server map for a (user, agent) pair.
   * Returns only servers the user is permitted to access,
   * wrapped in authorization proxies.
   */
  async resolveServers(userId: string, agentId: string): Promise<Record<string, unknown>> {
    // 1. Get agent config
    const agent = this.db.getAgent(agentId);
    if (!agent) return {};

    let agentServers: string[];
    try {
      agentServers = JSON.parse(agent.mcp_servers);
    } catch {
      agentServers = [];
    }
    if (!agentServers.length) return {};

    // 2. Get user's MCP policies (from roles + teams + direct)
    const policies = this.db.getMcpPoliciesForUser(userId);
    const policyMap = new Map(policies.map(p => [p.connection_id, p]));

    // 3. Intersect: agent wants it AND user has access AND connection is healthy
    const servers: Record<string, unknown> = {};

    for (const connectionId of agentServers) {
      const policy = policyMap.get(connectionId);
      if (!policy || policy.access_level === 'none') continue;

      const connection = this.db.getConnection(connectionId);
      if (!connection || connection.status !== 'connected') continue;

      const proxy = this.createGovernedProxy(userId, connectionId, connection, policy);

      // Realize the lazy proxy: connect to remote MCP and discover tools
      if (proxy && typeof proxy === 'object' && 'realize' in proxy) {
        try {
          servers[connectionId] = await (proxy as any).realize();
        } catch (err) {
          console.error(`[mcp-gateway] Failed to realize proxy for ${connectionId}:`, err);
        }
      } else {
        servers[connectionId] = proxy;
      }
    }

    return servers;
  }

  /**
   * Resolve credentials for a user+connection pair.
   * Three-tier resolution: user token → team token → company token.
   *
   * token_strategy:
   *   'user'    — each person connects their own account
   *   'team'    — team lead connects for the team (connection.team_id set)
   *   'company' — admin connects once, shared by all (default)
   */
  resolveCredentials(userId: string, connection: ConnectionRow): { token: string | null; source: 'user' | 'team' | 'company' } {
    // 1. Check for user-specific token (most specific)
    const userConn = this.db.getUserConnection(userId, connection.id);
    if (userConn?.credentials) {
      return { token: this.encryption.decrypt(userConn.credentials), source: 'user' };
    }

    // 2. Check for team-scoped token
    if (connection.token_strategy === 'team' && connection.team_id) {
      // Verify user is a member of this team
      const userTeams = this.db.getUserTeams(userId);
      const isMember = userTeams.some(t => t.id === connection.team_id);
      if (isMember && connection.credentials) {
        return { token: this.encryption.decrypt(connection.credentials), source: 'team' };
      }
      // User not in the team — no access via this connection
      return { token: null, source: 'team' };
    }

    // 3. If strategy is 'user' and no user token found, they need to connect
    if (connection.token_strategy === 'user') {
      return { token: null, source: 'user' };
    }

    // 4. Company-wide token (default)
    if (connection.credentials) {
      return { token: this.encryption.decrypt(connection.credentials), source: 'company' };
    }
    return { token: null, source: 'company' };
  }

  private createGovernedProxy(
    userId: string,
    connectionId: string,
    connection: ConnectionRow,
    policy: McpPolicyRow,
  ) {
    const allowedTools = policy.allowed_tools ? JSON.parse(policy.allowed_tools) as string[] : null;
    const deniedTools = policy.denied_tools ? JSON.parse(policy.denied_tools) as string[] : null;

    // Get tool classifications for this connection
    const classifications = this.db.getToolClassifications(connectionId);
    const classificationMap = new Map(classifications.map(c => [c.tool_name, c]));

    // Governance check shared by all forwarded tools
    const checkGovernance = (toolName: string): string | null => {
      if (deniedTools?.includes(toolName)) {
        this.auditToolCall(userId, connectionId, toolName, 'denied_by_policy');
        return `Permission denied: tool "${toolName}" is blocked by policy.`;
      }
      if (allowedTools && !allowedTools.includes(toolName)) {
        this.auditToolCall(userId, connectionId, toolName, 'denied_not_in_allowlist');
        return `Permission denied: tool "${toolName}" is not in the allowed list for this connection.`;
      }
      if (policy.access_level === 'read' && this.isWriteOperation(toolName, toolName)) {
        this.auditToolCall(userId, connectionId, toolName, 'denied_read_only');
        return `Permission denied: read-only access to ${connection.name}. Write operations are not allowed.`;
      }
      const classification = classificationMap.get(toolName);
      if (classification && !isClassificationAllowed(classification.data_classification, policy.max_data_classification)) {
        this.auditToolCall(userId, connectionId, toolName, 'denied_classification');
        return `Permission denied: "${toolName}" requires ${classification.data_classification} clearance, but your maximum is ${policy.max_data_classification}.`;
      }
      if (!this.rateLimiter.check(userId, connectionId, {
        perHour: policy.rate_limit_per_hour,
        perDay: policy.rate_limit_per_day,
      })) {
        this.auditToolCall(userId, connectionId, toolName, 'denied_rate_limit');
        return 'Rate limit exceeded. Try again later.';
      }
      return null;
    };

    // Resolve credentials and connect lazily
    const getClient = async (): Promise<{ client: Client; entry: McpClientEntry } | { error: string }> => {
      let token: string | null = null;

      // Try DB credentials first
      try {
        const { token: rawCredentials } = this.resolveCredentials(userId, connection);
        if (rawCredentials) {
          token = rawCredentials;
          // Extract bearer token from stored credentials (may be JSON like {"apiKey":"sk_..."})
          try {
            const parsed = JSON.parse(rawCredentials);
            token = parsed.apiKey ?? parsed.token ?? parsed.access_token ?? rawCredentials;
          } catch {
            // Not JSON — use as-is
          }
        }
      } catch (err) {
        console.warn(`[mcp-gateway] DB credential decryption failed for ${connectionId}, trying env fallback:`, err instanceof Error ? err.message : err);
      }

      // Env fallback for known connection types
      if (!token && connection.type === 'shiplens' && config.shiplensApiKey) {
        token = config.shiplensApiKey;
        console.log(`[mcp-gateway] Using env SHIPLENS_API_KEY fallback for ${connectionId}`);
      }

      if (!token) {
        return { error: `Cannot access ${connection.name}: no valid credentials found. Check encryption key or re-save credentials.` };
      }

      // Resolve URL: DB field first, then env fallback for known types
      const mcpUrl = connection.mcp_server_url
        || (connection.type === 'shiplens' ? config.shiplensUrl : null);
      if (!mcpUrl) {
        return { error: `Connection ${connection.name} has no MCP server URL configured.` };
      }
      try {
        const entry = await this.getOrCreateClient(connectionId, mcpUrl, token);
        return { client: entry.client, entry };
      } catch (err) {
        // Evict broken client and report
        await this.disconnectClient(connectionId);
        console.error(`[mcp-gateway] Failed to connect to ${connectionId}:`, err);
        return { error: `Failed to connect to ${connection.name}: ${err instanceof Error ? err.message : String(err)}` };
      }
    };

    // Connect eagerly to discover remote tools, then expose each one individually
    const serverName = connection.name.toLowerCase().replace(/\s+/g, '-');
    const gateway = this;

    // We return a lazy proxy that discovers tools on first use, but we also
    // expose a passthrough tool immediately so the SDK has something to register.
    // The real magic: we connect and discover tools, then create one SDK tool per remote tool.
    return {
      _type: 'lazy-governed-proxy' as const,
      connectionId,
      connection,
      policy,
      userId,
      // This gets resolved by our patched resolveServers
      async realize(): Promise<ReturnType<typeof createSdkMcpServer>> {
        const clientResult = await getClient();
        if ('error' in clientResult) {
          console.error(`[mcp-gateway] Cannot realize proxy for ${connectionId}: ${clientResult.error}`);
          // Return a server with a single error tool
          return createSdkMcpServer({
            name: `governed-${serverName}`,
            version: '1.0.0',
            tools: [
              tool(
                `${serverName}_status`,
                `${connection.name} connection status`,
                {},
                async () => gateway.textResult(clientResult.error),
              ),
            ],
          });
        }

        const remoteTtools = clientResult.entry.tools;
        console.log(`[mcp-gateway] Realized proxy for ${connection.name}: ${remoteTtools.length} tools`);

        const sdkTools = remoteTtools.map((remoteTool) => {
          return tool(
            remoteTool.name,
            remoteTool.description ?? `${connection.name} tool: ${remoteTool.name}`,
            { params: z.record(z.unknown()).optional().describe('Tool parameters') },
            async (args) => {
              const denial = checkGovernance(remoteTool.name);
              if (denial) return gateway.textResult(denial);

              const result = await getClient();
              if ('error' in result) return gateway.textResult(result.error);

              gateway.auditToolCall(userId, connectionId, remoteTool.name, 'allowed', remoteTool.name);

              try {
                const mcpResult = await result.client.callTool({
                  name: remoteTool.name,
                  arguments: args.params ?? {},
                });
                return mcpResult as { content: Array<{ type: 'text'; text: string }> };
              } catch (err) {
                // Evict stale client and retry once with a fresh connection
                await gateway.disconnectClient(connectionId);
                const errMsg = err instanceof Error ? err.message : String(err);
                console.warn(`[mcp-gateway] Tool call ${remoteTool.name} on ${connectionId} failed (will retry): ${errMsg}`);

                const retry = await getClient();
                if ('error' in retry) {
                  console.error(`[mcp-gateway] Retry connection failed for ${connectionId}: ${retry.error}`);
                  return gateway.textResult(`Tool call failed after retry: ${retry.error}`);
                }

                try {
                  const retryResult = await retry.client.callTool({
                    name: remoteTool.name,
                    arguments: args.params ?? {},
                  });
                  return retryResult as { content: Array<{ type: 'text'; text: string }> };
                } catch (retryErr) {
                  await gateway.disconnectClient(connectionId);
                  const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  console.error(`[mcp-gateway] Tool call ${remoteTool.name} on ${connectionId} failed on retry:`, retryMsg);
                  return gateway.textResult(`Tool call failed: ${retryMsg}`);
                }
              }
            },
          );
        });

        return createSdkMcpServer({
          name: `governed-${serverName}`,
          version: '1.0.0',
          tools: sdkTools,
        });
      },
    };
  }

  private isWriteOperation(toolName: string, action: string): boolean {
    const writePatterns = ['write', 'create', 'update', 'delete', 'remove', 'put', 'post', 'patch', 'set', 'add', 'insert', 'modify'];
    const combined = `${toolName} ${action}`.toLowerCase();
    return writePatterns.some(p => combined.includes(p));
  }

  private auditToolCall(userId: string, connectionId: string, toolName: string, decision: string, action?: string): void {
    this.db.logAudit(
      null,
      'mcp_tool_call',
      {
        connection_id: connectionId,
        tool: toolName,
        action: action ?? toolName,
        access_decision: decision,
        user_id: userId,
      },
      'web',
    );
  }

  private textResult(text: string) {
    return { content: [{ type: 'text' as const, text }] };
  }
}

/**
 * In-memory rate limiter with per-hour and per-day sliding windows.
 */
class RateLimiter {
  private hourly = new Map<string, { count: number; resetAt: number }>();
  private daily = new Map<string, { count: number; resetAt: number }>();

  check(userId: string, connectionId: string, limits: { perHour: number | null; perDay: number | null }): boolean {
    const key = `${userId}:${connectionId}`;
    const now = Date.now();

    if (limits.perHour) {
      const h = this.hourly.get(key);
      if (!h || now > h.resetAt) {
        this.hourly.set(key, { count: 1, resetAt: now + 3_600_000 });
      } else {
        if (h.count >= limits.perHour) return false;
        h.count++;
      }
    }

    if (limits.perDay) {
      const d = this.daily.get(key);
      if (!d || now > d.resetAt) {
        this.daily.set(key, { count: 1, resetAt: now + 86_400_000 });
      } else {
        if (d.count >= limits.perDay) return false;
        d.count++;
      }
    }

    return true;
  }
}
