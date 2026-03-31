import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { DatabaseService } from './database.js';
import type { EncryptionService } from './encryption.js';
import type { McpPolicyRow, ConnectionRow } from '../types/index.js';

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

export class McpGateway {
  private rateLimiter = new RateLimiter();

  constructor(
    private db: DatabaseService,
    private encryption: EncryptionService,
  ) {}

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

      // Create governed proxy
      servers[connectionId] = this.createGovernedProxy(userId, connectionId, connection, policy);
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

    return createSdkMcpServer({
      name: `governed-${connectionId}`,
      version: '1.0.0',
      tools: [
        tool(
          `${connectionId}_query`,
          `Query ${connection.name} (governed). Access level: ${policy.access_level}. Use this to interact with the ${connection.name} integration.`,
          {
            action: z.string().describe('The action to perform'),
            tool_name: z.string().optional().describe('Specific tool name within the connection'),
            params: z.record(z.unknown()).optional().describe('Action parameters'),
          },
          async (args) => {
            const toolName = args.tool_name ?? args.action;

            // 1. Tool-level filtering
            if (deniedTools?.includes(toolName)) {
              this.auditToolCall(userId, connectionId, toolName, 'denied_by_policy');
              return this.textResult(`Permission denied: tool "${toolName}" is blocked by policy.`);
            }
            if (allowedTools && !allowedTools.includes(toolName)) {
              this.auditToolCall(userId, connectionId, toolName, 'denied_not_in_allowlist');
              return this.textResult(`Permission denied: tool "${toolName}" is not in the allowed list for this connection.`);
            }

            // 2. Write operation check for read-only access
            if (policy.access_level === 'read' && this.isWriteOperation(toolName, args.action)) {
              this.auditToolCall(userId, connectionId, toolName, 'denied_read_only');
              return this.textResult(`Permission denied: read-only access to ${connection.name}. Write operations are not allowed.`);
            }

            // 3. Data classification check
            const classification = classificationMap.get(toolName);
            if (classification && !isClassificationAllowed(classification.data_classification, policy.max_data_classification)) {
              this.auditToolCall(userId, connectionId, toolName, 'denied_classification');
              return this.textResult(
                `Permission denied: "${toolName}" requires ${classification.data_classification} clearance, but your maximum is ${policy.max_data_classification}.`,
              );
            }

            // 4. Rate limit check
            if (!this.rateLimiter.check(userId, connectionId, {
              perHour: policy.rate_limit_per_hour,
              perDay: policy.rate_limit_per_day,
            })) {
              this.auditToolCall(userId, connectionId, toolName, 'denied_rate_limit');
              return this.textResult('Rate limit exceeded. Try again later.');
            }

            // 5. Credential resolution (user → team → company)
            const { token: credentials, source: credSource } = this.resolveCredentials(userId, connection);
            if (!credentials) {
              const hint = credSource === 'user'
                ? 'Please connect your account in My Connections.'
                : credSource === 'team'
                ? 'Your team has not connected this service, or you are not a member of the team.'
                : 'This connection has no credentials configured. Ask an admin.';
              this.auditToolCall(userId, connectionId, toolName, 'denied_no_credentials');
              return this.textResult(`Cannot access ${connection.name}: ${hint}`);
            }

            // 6. Log the allowed call
            this.auditToolCall(userId, connectionId, toolName, 'allowed', args.action);

            // 7. Forward to real MCP server (when registry is ready)
            return this.textResult(
              `[Governed MCP] Connection: ${connection.name}, Action: ${args.action}, Tool: ${toolName}, ` +
              `Access: ${policy.access_level}, Token: ${credSource}. ` +
              `Real MCP forwarding pending registry integration.`,
            );
          },
        ),
      ],
    });
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
