import type { DatabaseService } from './database.js';
import type { McpPolicyRow, KnowledgePolicyRow, AgentPolicyRow } from '../types/index.js';

// ─── Types ──────────────────────────────────────────────────────

export interface McpAccessResult {
  level: 'none' | 'read' | 'write' | 'admin';
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  maxClassification: string;
  ratePerHour: number | null;
  ratePerDay: number | null;
}

export interface EffectivePermissions {
  mcpAccess: Map<string, McpAccessResult & { connectionId: string }>;
  knowledgeAccess: Map<string, 'none' | 'read' | 'write'>;
  agentAccess: Map<string, { canUse: boolean; canConfigure: boolean }>;
  platformPermissions: Set<string>;
}

// Access level hierarchy (higher index = more permissive)
const MCP_ACCESS_LEVELS = ['none', 'read', 'write', 'admin'] as const;
const KNOWLEDGE_ACCESS_LEVELS = ['none', 'read', 'write'] as const;

function mcpLevelIndex(level: string): number {
  return MCP_ACCESS_LEVELS.indexOf(level as typeof MCP_ACCESS_LEVELS[number]);
}

function knowledgeLevelIndex(level: string): number {
  return KNOWLEDGE_ACCESS_LEVELS.indexOf(level as typeof KNOWLEDGE_ACCESS_LEVELS[number]);
}

// ─── RBAC Service ───────────────────────────────────────────────

export class RbacService {
  constructor(private db: DatabaseService) {}

  /**
   * Check if a user has the admin role.
   */
  isAdmin(userId: string): boolean {
    const roles = this.db.getUserRoles(userId);
    return roles.some(r => r.name === 'admin' || r.id === 'admin');
  }

  /**
   * Check if a user has a specific platform permission.
   * Currently permissions map 1:1 with role names.
   */
  hasPermission(userId: string, permission: string): boolean {
    if (this.isAdmin(userId)) return true;
    const roles = this.db.getUserRoles(userId);
    return roles.some(r => r.name === permission || r.id === permission);
  }

  /**
   * Resolve all effective permissions for a user.
   */
  getEffectivePermissions(userId: string): EffectivePermissions {
    const mcpAccess = this._resolveMcpAccess(userId);
    const knowledgeAccess = this._resolveKnowledgeAccess(userId);
    const agentAccess = this._resolveAgentAccess(userId);
    const platformPermissions = this._resolvePlatformPermissions(userId);

    return { mcpAccess, knowledgeAccess, agentAccess, platformPermissions };
  }

  /**
   * Check if a user can access a specific MCP connection, and with what parameters.
   * Returns null if no access (default deny).
   */
  canAccessMcp(userId: string, connectionId: string): McpAccessResult | null {
    // Admins get full access
    if (this.isAdmin(userId)) {
      return {
        level: 'admin',
        allowedTools: null,
        deniedTools: null,
        maxClassification: 'top-secret',
        ratePerHour: null,
        ratePerDay: null,
      };
    }

    const policies = this.db.getMcpPoliciesForUser(userId);
    const matching = policies.filter(p => p.connection_id === connectionId);

    if (matching.length === 0) return null; // default deny

    return this._resolveMcpPolicies(matching);
  }

  /**
   * Check if a user can use a specific agent.
   */
  canUseAgent(userId: string, agentId: string): boolean {
    if (this.isAdmin(userId)) return true;

    const policies = this.db.getAgentPoliciesForUser(userId);
    const matching = policies.filter(p => p.agent_id === agentId);

    if (matching.length === 0) return false; // default deny

    // Any can_use = 1 grants access (most permissive)
    return matching.some(p => p.can_use === 1);
  }

  /**
   * Check if a user can access a specific knowledge source.
   * Returns the access level or null if no access.
   */
  canAccessKnowledge(userId: string, sourceId: string): 'none' | 'read' | 'write' | null {
    if (this.isAdmin(userId)) return 'write';

    const policies = this.db.getKnowledgePoliciesForUser(userId);
    const matching = policies.filter(p => p.knowledge_source_id === sourceId);

    if (matching.length === 0) return null; // default deny

    return this._resolveKnowledgePolicies(matching);
  }

  // ─── Private Resolution Methods ─────────────────────────────────

  private _resolveMcpAccess(userId: string): Map<string, McpAccessResult & { connectionId: string }> {
    const result = new Map<string, McpAccessResult & { connectionId: string }>();

    // Admins: grant admin access to all connections
    if (this.isAdmin(userId)) {
      const connections = this.db.getConnections();
      for (const conn of connections) {
        result.set(conn.id, {
          connectionId: conn.id,
          level: 'admin',
          allowedTools: null,
          deniedTools: null,
          maxClassification: 'top-secret',
          ratePerHour: null,
          ratePerDay: null,
        });
      }
      return result;
    }

    const policies = this.db.getMcpPoliciesForUser(userId);

    // Group by connection_id
    const byConnection = new Map<string, McpPolicyRow[]>();
    for (const p of policies) {
      const existing = byConnection.get(p.connection_id) || [];
      existing.push(p);
      byConnection.set(p.connection_id, existing);
    }

    for (const [connectionId, connPolicies] of byConnection) {
      const resolved = this._resolveMcpPolicies(connPolicies);
      if (resolved && resolved.level !== 'none') {
        result.set(connectionId, { connectionId, ...resolved });
      }
    }

    return result;
  }

  private _resolveMcpPolicies(policies: McpPolicyRow[]): McpAccessResult | null {
    if (policies.length === 0) return null;

    // Deny override: if ANY policy says 'none', deny
    if (policies.some(p => p.access_level === 'none')) {
      return {
        level: 'none',
        allowedTools: null,
        deniedTools: null,
        maxClassification: 'public',
        ratePerHour: null,
        ratePerDay: null,
      };
    }

    // Take most permissive access level
    let maxLevel = 0;
    for (const p of policies) {
      const idx = mcpLevelIndex(p.access_level);
      if (idx > maxLevel) maxLevel = idx;
    }

    // Merge allowed tools: union of all allowed (null = all allowed, takes precedence)
    let allowedTools: string[] | null = [];
    for (const p of policies) {
      if (p.allowed_tools === null) {
        allowedTools = null;
        break;
      }
      try {
        const tools = JSON.parse(p.allowed_tools) as string[];
        if (allowedTools !== null) {
          for (const t of tools) {
            if (!allowedTools.includes(t)) allowedTools.push(t);
          }
        }
      } catch {
        // Skip malformed
      }
    }

    // Merge denied tools: intersection of all denied (strictest common denial)
    let deniedTools: string[] | null = null;
    for (const p of policies) {
      if (p.denied_tools === null) continue;
      try {
        const tools = JSON.parse(p.denied_tools) as string[];
        if (deniedTools === null) {
          deniedTools = tools;
        } else {
          // Intersection: keep only tools that appear in all denied lists
          deniedTools = deniedTools.filter(t => tools.includes(t));
        }
      } catch {
        // Skip malformed
      }
    }

    // Take highest classification across policies
    const classificationOrder = ['public', 'internal', 'confidential', 'restricted', 'top-secret'];
    let maxClassIdx = 0;
    for (const p of policies) {
      const idx = classificationOrder.indexOf(p.max_data_classification);
      if (idx > maxClassIdx) maxClassIdx = idx;
    }

    // Rate limits: take most permissive (highest values; null = unlimited, takes precedence)
    let ratePerHour: number | null = 0;
    let ratePerDay: number | null = 0;
    for (const p of policies) {
      if (p.rate_limit_per_hour === null) { ratePerHour = null; }
      else if (ratePerHour !== null && p.rate_limit_per_hour > ratePerHour) { ratePerHour = p.rate_limit_per_hour; }
      if (p.rate_limit_per_day === null) { ratePerDay = null; }
      else if (ratePerDay !== null && p.rate_limit_per_day > ratePerDay) { ratePerDay = p.rate_limit_per_day; }
    }

    return {
      level: MCP_ACCESS_LEVELS[maxLevel],
      allowedTools: allowedTools && allowedTools.length > 0 ? allowedTools : null,
      deniedTools: deniedTools && deniedTools.length > 0 ? deniedTools : null,
      maxClassification: classificationOrder[maxClassIdx],
      ratePerHour: ratePerHour === 0 ? null : ratePerHour,
      ratePerDay: ratePerDay === 0 ? null : ratePerDay,
    };
  }

  private _resolveKnowledgeAccess(userId: string): Map<string, 'none' | 'read' | 'write'> {
    const result = new Map<string, 'none' | 'read' | 'write'>();

    if (this.isAdmin(userId)) {
      const sources = this.db.getKnowledgeSources();
      for (const s of sources) {
        result.set(s.id, 'write');
      }
      return result;
    }

    const policies = this.db.getKnowledgePoliciesForUser(userId);

    const bySource = new Map<string, KnowledgePolicyRow[]>();
    for (const p of policies) {
      const existing = bySource.get(p.knowledge_source_id) || [];
      existing.push(p);
      bySource.set(p.knowledge_source_id, existing);
    }

    for (const [sourceId, sourcePolicies] of bySource) {
      const resolved = this._resolveKnowledgePolicies(sourcePolicies);
      if (resolved && resolved !== 'none') {
        result.set(sourceId, resolved);
      }
    }

    return result;
  }

  private _resolveKnowledgePolicies(policies: KnowledgePolicyRow[]): 'none' | 'read' | 'write' | null {
    if (policies.length === 0) return null;

    // Deny override
    if (policies.some(p => p.access_level === 'none')) return 'none';

    // Most permissive
    let maxLevel = 0;
    for (const p of policies) {
      const idx = knowledgeLevelIndex(p.access_level);
      if (idx > maxLevel) maxLevel = idx;
    }

    return KNOWLEDGE_ACCESS_LEVELS[maxLevel];
  }

  private _resolveAgentAccess(userId: string): Map<string, { canUse: boolean; canConfigure: boolean }> {
    const result = new Map<string, { canUse: boolean; canConfigure: boolean }>();

    if (this.isAdmin(userId)) {
      const agents = this.db.getAgents();
      for (const a of agents) {
        result.set(a.id, { canUse: true, canConfigure: true });
      }
      return result;
    }

    const policies = this.db.getAgentPoliciesForUser(userId);

    const byAgent = new Map<string, AgentPolicyRow[]>();
    for (const p of policies) {
      const existing = byAgent.get(p.agent_id) || [];
      existing.push(p);
      byAgent.set(p.agent_id, existing);
    }

    for (const [agentId, agentPolicies] of byAgent) {
      // Most permissive across all policies
      const canUse = agentPolicies.some(p => p.can_use === 1);
      const canConfigure = agentPolicies.some(p => p.can_configure === 1);
      if (canUse || canConfigure) {
        result.set(agentId, { canUse, canConfigure });
      }
    }

    return result;
  }

  private _resolvePlatformPermissions(userId: string): Set<string> {
    const permissions = new Set<string>();
    const roles = this.db.getUserRoles(userId);

    for (const role of roles) {
      permissions.add(role.name);
      // Admin gets all permissions
      if (role.id === 'admin' || role.name === 'admin') {
        permissions.add('admin');
        permissions.add('manage_users');
        permissions.add('manage_roles');
        permissions.add('manage_teams');
        permissions.add('manage_connections');
        permissions.add('manage_agents');
        permissions.add('manage_schedules');
        permissions.add('manage_settings');
        permissions.add('manage_policies');
      }
    }

    return permissions;
  }
}
