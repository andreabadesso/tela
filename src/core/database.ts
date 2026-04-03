import Database from 'better-sqlite3';
import path from 'node:path';
import { runMigrations } from '../migrations/runner.js';
import type {
  ConversationRow,
  JobRunRow,
  EodStateRow,
  AgentRow,
  ConnectionRow,
  ScheduleRow,
  KnowledgeSourceRow,
  AuditLogRow,
  SettingRow,
  NotificationChannelRow,
  CommunicationChannelRow,
  ChannelThreadRow,
  TaskCheckoutRow,
  CostEventRow,
  BudgetPolicyRow,
  ApprovalRow,
  UserRow,
  RoleRow,
  TeamRow,
  UserApiKeyRow,
  McpPolicyRow,
  KnowledgePolicyRow,
  AgentPolicyRow,
  UserConnectionRow,
  McpToolClassificationRow,
  AgentMemoryRow,
  AgentBehaviorConfigRow,
} from '../types/index.js';
import type { AgentRunRow } from '../types/runtime.js';
import type { A2ATaskRow, A2APushConfigRow } from '../a2a/types.js';
import type { WorkspaceRow } from '../runtime/workspace-manager.js';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'agent.db');

export class DatabaseService {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? DB_PATH);
    this.db.pragma('journal_mode = WAL');
    runMigrations(this.db);
    this.seed();
  }

  private seed(): void {
    const agentCount = this.db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
    if (agentCount.count === 0) {
      this.createAgent({
        id: 'default',
        name: 'Assistant',
        model: 'claude-sonnet-4-6',
        system_prompt: 'You are a helpful assistant. Answer questions clearly and concisely.',
        mcp_servers: '[]',
        knowledge_sources: '[]',
        permissions: '{}',
        max_turns: 15,
        enabled: 1,
      });
      console.log('[database] seeded default agent');
    }

    // Seed or update coding agent
    if (!this.getAgent('coding-agent')) {
      this.createAgent({
        id: 'coding-agent',
        name: 'Coding Agent',
        model: 'claude-sonnet-4-6',
        system_prompt: CODING_AGENT_SYSTEM_PROMPT,
        mcp_servers: '[]',
        knowledge_sources: '[]',
        permissions: JSON.stringify({
          runtime: 'devcontainer',
          workspace: true,
          max_workspace_disk_mb: 10240,
          allowed_ports: [3000, 3001, 4000, 5173, 8000, 8080],
          max_background_processes: 5,
        }),
        max_turns: 50,
        enabled: 1,
      });
      console.log('[database] seeded coding agent');
    } else {
      // Always update the system prompt to the latest version
      this.db.prepare('UPDATE agents SET system_prompt = ? WHERE id = ?')
        .run(CODING_AGENT_SYSTEM_PROMPT, 'coding-agent');
    }

    // Seed default system roles
    const roleCount = this.db.prepare('SELECT COUNT(*) as count FROM roles').get() as { count: number };
    if (roleCount.count === 0) {
      const systemRoles = [
        { id: 'admin', name: 'Admin', description: 'Full platform access. Manages users, connections, agents, policies.' },
        { id: 'engineering', name: 'Engineering', description: 'Access to GitHub, Jira, CI/CD, monitoring, ShipLens. Engineering docs.' },
        { id: 'finance', name: 'Finance', description: 'Access to financial systems, budget tools. Financial docs.' },
        { id: 'sales', name: 'Sales', description: 'Access to CRM, pipeline tools. Sales docs.' },
        { id: 'hr', name: 'HR', description: 'Access to people tools, payroll (read). HR docs.' },
        { id: 'leadership', name: 'Leadership', description: 'Read access to all connections and knowledge. All agents.' },
        { id: 'viewer', name: 'Viewer', description: 'No MCP access. Default agent only. For trainees and new hires.' },
      ];
      const insertRole = this.db.prepare(`
        INSERT INTO roles (id, name, description, is_system) VALUES (?, ?, ?, 1)
      `);
      for (const role of systemRoles) {
        insertRole.run(role.id, role.name, role.description);
      }
      console.log('[database] seeded 7 default system roles');
    }

    // Seed default MCP policies for admin and leadership roles
    this.seedDefaultMcpPolicies();
  }

  private seedDefaultMcpPolicies(): void {
    // Only seed if there are connections and no policies yet
    const policyCount = this.db.prepare('SELECT COUNT(*) as count FROM mcp_policies').get() as { count: number };
    if (policyCount.count > 0) return;

    const connections = this.db.prepare('SELECT id FROM connections').all() as { id: string }[];
    if (connections.length === 0) return;

    const insertPolicy = this.db.prepare(`
      INSERT OR IGNORE INTO mcp_policies (id, principal_type, principal_id, connection_id, access_level, max_data_classification)
      VALUES (?, 'role', ?, ?, ?, 'confidential')
    `);

    for (const conn of connections) {
      // Admin: write access to all connections
      insertPolicy.run(`policy-admin-${conn.id}`, 'admin', conn.id, 'admin');
      // Leadership: read access to all connections
      insertPolicy.run(`policy-leadership-${conn.id}`, 'leadership', conn.id, 'read');
    }
    if (connections.length > 0) {
      console.log('[database] seeded default MCP policies for admin and leadership roles');
    }
  }

  // ─── Agents CRUD ───────────────────────────────────────────────

  getAgents(): AgentRow[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY created_at').all() as AgentRow[];
  }

  getAgent(id: string): AgentRow | undefined {
    return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
  }

  createAgent(data: Omit<AgentRow, 'created_at' | 'updated_at'> & { id?: string }): AgentRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO agents (id, name, model, system_prompt, mcp_servers, knowledge_sources, permissions, max_turns, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.name,
      data.model ?? 'claude-sonnet-4-6',
      data.system_prompt,
      data.mcp_servers ?? '[]',
      data.knowledge_sources ?? '[]',
      data.permissions ?? '{}',
      data.max_turns ?? 15,
      data.enabled ?? 1,
    );
    return this.getAgent(id)!;
  }

  updateAgent(id: string, data: Partial<Omit<AgentRow, 'id' | 'created_at'>>): AgentRow | undefined {
    const existing = this.getAgent(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getAgent(id);
  }

  deleteAgent(id: string): boolean {
    const result = this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Connections CRUD ──────────────────────────────────────────

  getConnections(): ConnectionRow[] {
    return this.db.prepare('SELECT * FROM connections ORDER BY created_at').all() as ConnectionRow[];
  }

  getConnectionsByTeam(teamId: string): ConnectionRow[] {
    return this.db.prepare('SELECT * FROM connections WHERE team_id = ? ORDER BY created_at').all(teamId) as ConnectionRow[];
  }

  getConnectionsForUser(userId: string): ConnectionRow[] {
    // Return: company-wide connections + connections for user's teams + user-delegated connections
    const userTeams = this.getUserTeams(userId);
    const teamIds = userTeams.map(t => t.id);

    const all = this.getConnections();
    return all.filter(c => {
      if (c.token_strategy === 'company') return true;
      if (c.token_strategy === 'team' && c.team_id && teamIds.includes(c.team_id)) return true;
      if (c.token_strategy === 'user') return true; // user needs to connect individually
      return false;
    });
  }

  getConnection(id: string): ConnectionRow | undefined {
    return this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow | undefined;
  }

  createConnection(data: Omit<ConnectionRow, 'created_at' | 'updated_at' | 'token_strategy' | 'team_id'> & { id?: string; token_strategy?: 'company' | 'team' | 'user'; team_id?: string | null }): ConnectionRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO connections (id, name, type, status, config, credentials, mcp_server_url, token_strategy, team_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.name, data.type, data.status ?? 'disconnected', data.config ?? '{}', data.credentials ?? null, data.mcp_server_url ?? null, data.token_strategy ?? 'company', data.team_id ?? null);
    return this.getConnection(id)!;
  }

  updateConnection(id: string, data: Partial<Omit<ConnectionRow, 'id' | 'created_at'>>): ConnectionRow | undefined {
    const existing = this.getConnection(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE connections SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getConnection(id);
  }

  deleteConnection(id: string): boolean {
    const result = this.db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Schedules CRUD ────────────────────────────────────────────

  getSchedules(): ScheduleRow[] {
    return this.db.prepare('SELECT * FROM schedules ORDER BY created_at').all() as ScheduleRow[];
  }

  getSchedule(id: string): ScheduleRow | undefined {
    return this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
  }

  createSchedule(data: Omit<ScheduleRow, 'created_at' | 'updated_at'> & { id?: string }): ScheduleRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO schedules (id, name, cron_expression, agent_id, prompt, notification_channels, enabled, type, mode, run_at, created_by_agent_id, target_channel, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.name,
      data.cron_expression,
      data.agent_id,
      data.prompt,
      data.notification_channels ?? '["telegram"]',
      data.enabled ?? 1,
      data.type ?? 'cron',
      data.mode ?? 'agent',
      data.run_at ?? null,
      data.created_by_agent_id ?? null,
      data.target_channel ?? null,
      data.status ?? 'active',
    );
    return this.getSchedule(id)!;
  }

  updateSchedule(id: string, data: Partial<Omit<ScheduleRow, 'id' | 'created_at'>>): ScheduleRow | undefined {
    const existing = this.getSchedule(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getSchedule(id);
  }

  deleteSchedule(id: string): boolean {
    const result = this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getScheduleHistory(scheduleId: string, limit = 10): JobRunRow[] {
    return this.db.prepare(`
      SELECT * FROM job_runs
      WHERE job_name = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(`schedule:${scheduleId}`, limit) as JobRunRow[];
  }

  getSchedulesByCreator(agentId: string): ScheduleRow[] {
    return this.db.prepare(
      'SELECT * FROM schedules WHERE created_by_agent_id = ? ORDER BY created_at DESC',
    ).all(agentId) as ScheduleRow[];
  }

  updateScheduleStatus(id: string, status: ScheduleRow['status']): void {
    this.db.prepare(
      "UPDATE schedules SET status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(status, id);
  }

  getActiveSchedules(): ScheduleRow[] {
    return this.db.prepare(
      "SELECT * FROM schedules WHERE status = 'active' AND enabled = 1 ORDER BY created_at",
    ).all() as ScheduleRow[];
  }

  // ─── Knowledge Sources CRUD ────────────────────────────────────

  getKnowledgeSources(): KnowledgeSourceRow[] {
    return this.db.prepare('SELECT * FROM knowledge_sources ORDER BY created_at').all() as KnowledgeSourceRow[];
  }

  getKnowledgeSource(id: string): KnowledgeSourceRow | undefined {
    return this.db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(id) as KnowledgeSourceRow | undefined;
  }

  createKnowledgeSource(data: Omit<KnowledgeSourceRow, 'created_at' | 'updated_at'> & { id?: string }): KnowledgeSourceRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO knowledge_sources (id, name, type, config, status, doc_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.name, data.type, data.config ?? '{}', data.status ?? 'disconnected', data.doc_count ?? 0);
    return this.getKnowledgeSource(id)!;
  }

  updateKnowledgeSource(id: string, data: Partial<Omit<KnowledgeSourceRow, 'id' | 'created_at'>>): KnowledgeSourceRow | undefined {
    const existing = this.getKnowledgeSource(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE knowledge_sources SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getKnowledgeSource(id);
  }

  deleteKnowledgeSource(id: string): boolean {
    const result = this.db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Notification Channels CRUD ────────────────────────────────

  getNotificationChannels(): NotificationChannelRow[] {
    return this.db.prepare('SELECT * FROM notification_channels ORDER BY created_at').all() as NotificationChannelRow[];
  }

  getNotificationChannel(id: string): NotificationChannelRow | undefined {
    return this.db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id) as NotificationChannelRow | undefined;
  }

  createNotificationChannel(data: Omit<NotificationChannelRow, 'created_at' | 'updated_at'> & { id?: string }): NotificationChannelRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO notification_channels (id, type, name, config, enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, data.type, data.name, data.config ?? '{}', data.enabled ?? 1);
    return this.getNotificationChannel(id)!;
  }

  updateNotificationChannel(id: string, data: Partial<Omit<NotificationChannelRow, 'id' | 'created_at'>>): NotificationChannelRow | undefined {
    const existing = this.getNotificationChannel(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE notification_channels SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getNotificationChannel(id);
  }

  deleteNotificationChannel(id: string): boolean {
    const result = this.db.prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Notifications (Web Channel Storage) ────────────────────────

  createNotification(data: { channel_id: string | null; title: string | null; body: string; priority: string; source: string }): void {
    this.db.prepare(`
      INSERT INTO notifications (channel_id, title, body, priority, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.channel_id, data.title, data.body, data.priority, data.source);
  }

  getNotifications(opts: { limit?: number; offset?: number; read?: boolean }): { id: number; channel_id: string | null; title: string | null; body: string; priority: string; source: string; read: number; created_at: string }[] {
    const { limit = 50, offset = 0, read } = opts;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (read !== undefined) {
      conditions.push('read = ?');
      params.push(read ? 1 : 0);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);
    return this.db.prepare(`SELECT * FROM notifications ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params) as { id: number; channel_id: string | null; title: string | null; body: string; priority: string; source: string; read: number; created_at: string }[];
  }

  markNotificationAsRead(id: number): void {
    this.db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
  }

  getUnreadNotificationCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM notifications WHERE read = 0').get() as { count: number };
    return row.count;
  }

  // ─── Audit Log ─────────────────────────────────────────────────

  logAudit(agentId: string | null, action: string, details: Record<string, unknown>, source: string, durationMs?: number): void {
    this.db.prepare(`
      INSERT INTO audit_log (agent_id, action, details, source, duration_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(agentId, action, JSON.stringify(details), source, durationMs ?? null);
  }

  getAuditLog(opts: { limit?: number; offset?: number; agentId?: string; action?: string; source?: string; from?: string; to?: string }): AuditLogRow[] {
    const { limit = 50, offset = 0, agentId, action, source, from, to } = opts;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (agentId) { conditions.push('agent_id = ?'); params.push(agentId); }
    if (action) { conditions.push('action = ?'); params.push(action); }
    if (source) { conditions.push('source = ?'); params.push(source); }
    if (from) { conditions.push('created_at >= ?'); params.push(from); }
    if (to) { conditions.push('created_at <= ?'); params.push(to); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);
    return this.db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params) as AuditLogRow[];
  }

  getAuditLogCount(opts?: { agentId?: string; action?: string; source?: string; from?: string; to?: string }): number {
    const { agentId, action, source, from, to } = opts ?? {};
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (agentId) { conditions.push('agent_id = ?'); params.push(agentId); }
    if (action) { conditions.push('action = ?'); params.push(action); }
    if (source) { conditions.push('source = ?'); params.push(source); }
    if (from) { conditions.push('created_at >= ?'); params.push(from); }
    if (to) { conditions.push('created_at <= ?'); params.push(to); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM audit_log ${where}`).get(...params) as { count: number };
    return row.count;
  }

  // ─── Settings ──────────────────────────────────────────────────

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value);
  }

  getAllSettings(): SettingRow[] {
    return this.db.prepare('SELECT * FROM settings ORDER BY key').all() as SettingRow[];
  }

  deleteSetting(key: string): boolean {
    const result = this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return result.changes > 0;
  }

  // ─── Chat Threads ──────────────────────────────────────────────

  getChatThreads(userId: string, agentId?: string): { id: string; user_id: string; agent_id: string; title: string | null; created_at: string; updated_at: string }[] {
    if (agentId) {
      return this.db.prepare('SELECT * FROM chat_threads WHERE user_id = ? AND agent_id = ? ORDER BY updated_at DESC').all(userId, agentId) as any[];
    }
    return this.db.prepare('SELECT * FROM chat_threads WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as any[];
  }

  getChatThread(threadId: string): { id: string; user_id: string; agent_id: string; title: string | null; created_at: string; updated_at: string } | undefined {
    return this.db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as any;
  }

  createChatThread(userId: string, agentId: string, title?: string): { id: string; user_id: string; agent_id: string; title: string | null; created_at: string; updated_at: string } {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO chat_threads (id, user_id, agent_id, title) VALUES (?, ?, ?, ?)').run(id, userId, agentId, title ?? null);
    return this.getChatThread(id)!;
  }

  updateChatThread(threadId: string, data: { title?: string }): void {
    if (data.title !== undefined) {
      this.db.prepare("UPDATE chat_threads SET title = ?, updated_at = datetime('now') WHERE id = ?").run(data.title, threadId);
    } else {
      this.db.prepare("UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?").run(threadId);
    }
  }

  deleteChatThread(threadId: string): boolean {
    const result = this.db.prepare('DELETE FROM chat_threads WHERE id = ?').run(threadId);
    return result.changes > 0;
  }

  getChatMessages(threadId: string): { id: string; thread_id: string; role: string; content: string; tool_calls: string | null; created_at: string }[] {
    return this.db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC').all(threadId) as any[];
  }

  addChatMessage(threadId: string, role: string, content: string, toolCalls?: unknown[]): string {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO chat_messages (id, thread_id, role, content, tool_calls) VALUES (?, ?, ?, ?, ?)').run(
      id, threadId, role, content, toolCalls ? JSON.stringify(toolCalls) : null,
    );
    // Touch thread updated_at
    this.db.prepare("UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?").run(threadId);
    return id;
  }

  // ─── Conversations (legacy) ───────────────────────────────────

  logConversation(data: {
    source: string;
    input: string;
    output: string;
    agentId?: string;
    toolCalls?: unknown[];
    tokensIn?: number;
    tokensOut?: number;
    durationMs?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO conversations (timestamp, source, input, output, agent_id, tool_calls, tokens_in, tokens_out, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      data.source,
      data.input,
      data.output,
      data.agentId ?? null,
      data.toolCalls ? JSON.stringify(data.toolCalls) : null,
      data.tokensIn ?? null,
      data.tokensOut ?? null,
      data.durationMs ?? null,
    );
  }

  getRecentConversations(source: string, limit = 10, agentId?: string): ConversationRow[] {
    if (agentId) {
      return this.db.prepare(`
        SELECT * FROM conversations
        WHERE source = ? AND agent_id = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(source, agentId, limit) as ConversationRow[];
    }
    return this.db.prepare(`
      SELECT * FROM conversations
      WHERE source = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(source, limit) as ConversationRow[];
  }

  getConversationCountToday(): number {
    const today = new Date().toISOString().split('T')[0];
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM conversations
      WHERE timestamp >= ?
    `).get(`${today}T00:00:00`) as { count: number };
    return row.count;
  }

  getErrorCount24h(): number {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM job_runs
      WHERE started_at >= ? AND status = 'error'
    `).get(since) as { count: number };
    return row.count;
  }

  getConversations(opts: { limit?: number; offset?: number; source?: string }): ConversationRow[] {
    const { limit = 50, offset = 0, source } = opts;
    if (source) {
      return this.db.prepare(`
        SELECT * FROM conversations
        WHERE source = ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `).all(source, limit, offset) as ConversationRow[];
    }
    return this.db.prepare(`
      SELECT * FROM conversations
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as ConversationRow[];
  }

  getConversationCount(source?: string): number {
    if (source) {
      const row = this.db.prepare(`SELECT COUNT(*) as count FROM conversations WHERE source = ?`).get(source) as { count: number };
      return row.count;
    }
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM conversations`).get() as { count: number };
    return row.count;
  }

  getConversation(id: number): ConversationRow | undefined {
    return this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as ConversationRow | undefined;
  }

  deleteConversation(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  // ─── Conversation Summaries ────────────────────────────────────

  getActiveSummary(agentId: string, source: string): import('../types/index.js').ConversationSummaryRow | undefined {
    return this.db.prepare(`
      SELECT * FROM conversation_summaries
      WHERE agent_id = ? AND source = ?
      ORDER BY covers_to_id DESC
      LIMIT 1
    `).get(agentId, source) as import('../types/index.js').ConversationSummaryRow | undefined;
  }

  createConversationSummary(data: {
    agent_id: string;
    source: string;
    summary: string;
    covers_from_id: number;
    covers_to_id: number;
    conversation_count: number;
    estimated_tokens: number;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO conversation_summaries (id, agent_id, source, summary, covers_from_id, covers_to_id, conversation_count, estimated_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      data.agent_id,
      data.source,
      data.summary,
      data.covers_from_id,
      data.covers_to_id,
      data.conversation_count,
      data.estimated_tokens,
    );
  }

  getConversationsOlderThan(agentId: string, source: string, beforeId: number, limit = 50): ConversationRow[] {
    return this.db.prepare(`
      SELECT * FROM conversations
      WHERE agent_id = ? AND source = ? AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `).all(agentId, source, beforeId, limit) as ConversationRow[];
  }

  getConversationCountForAgent(agentId: string, source: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM conversations WHERE agent_id = ? AND source = ?
    `).get(agentId, source) as { count: number };
    return row.count;
  }

  // ─── Job Runs ──────────────────────────────────────────────────

  startJobRun(jobName: string): number {
    const result = this.db.prepare(`
      INSERT INTO job_runs (job_name, started_at, status)
      VALUES (?, ?, 'running')
    `).run(jobName, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  finishJobRun(id: number, status: 'success' | 'error', output?: string, error?: string): void {
    this.db.prepare(`
      UPDATE job_runs SET finished_at = ?, status = ?, output = ?, error = ?
      WHERE id = ?
    `).run(new Date().toISOString(), status, output ?? null, error ?? null, id);
  }

  getConsecutiveFailures(jobName: string): number {
    const rows = this.db.prepare(`
      SELECT status FROM job_runs
      WHERE job_name = ?
      ORDER BY id DESC
      LIMIT 10
    `).all(jobName) as { status: string }[];

    let count = 0;
    for (const row of rows) {
      if (row.status === 'error') count++;
      else break;
    }
    return count;
  }

  getLastJobRuns(): Record<string, string> {
    const rows = this.db.prepare(`
      SELECT job_name, MAX(started_at) as last_run
      FROM job_runs
      WHERE status = 'success'
      GROUP BY job_name
    `).all() as { job_name: string; last_run: string }[];

    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.job_name] = row.last_run;
    }
    return result;
  }

  // ─── EOD State ─────────────────────────────────────────────────

  getEodState(date: string): EodStateRow | undefined {
    return this.db.prepare(`
      SELECT * FROM eod_state WHERE date = ?
    `).get(date) as EodStateRow | undefined;
  }

  setEodPrompted(date: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO eod_state (date, prompted_at)
      VALUES (?, ?)
    `).run(date, new Date().toISOString());
  }

  setEodResponse(date: string, response: string): void {
    this.db.prepare(`
      UPDATE eod_state SET response_received_at = ?, response = ?
      WHERE date = ?
    `).run(new Date().toISOString(), response, date);
  }

  setEodProcessed(date: string, updatesMade: string[]): void {
    this.db.prepare(`
      UPDATE eod_state SET processed_at = ?, updates_made = ?
      WHERE date = ?
    `).run(new Date().toISOString(), JSON.stringify(updatesMade), date);
  }

  // ─── Task Checkouts ────────────────────────────────────────────

  createTaskCheckout(data: { id: string; task_ref: string; agent_id: string; run_id: string; session_id?: string }): TaskCheckoutRow {
    this.db.prepare(`
      INSERT INTO task_checkouts (id, task_ref, agent_id, run_id, session_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.id, data.task_ref, data.agent_id, data.run_id, data.session_id ?? null);
    return this.db.prepare('SELECT * FROM task_checkouts WHERE id = ?').get(data.id) as TaskCheckoutRow;
  }

  releaseTaskCheckout(runId: string, status: 'completed' | 'cancelled'): void {
    this.db.prepare(`
      UPDATE task_checkouts SET status = ?, released_at = datetime('now')
      WHERE run_id = ? AND status = 'active'
    `).run(status, runId);
  }

  getActiveCheckout(taskRef: string): TaskCheckoutRow | undefined {
    return this.db.prepare(`
      SELECT * FROM task_checkouts WHERE task_ref = ? AND status = 'active'
    `).get(taskRef) as TaskCheckoutRow | undefined;
  }

  // ─── Cost Events ──────────────────────────────────────────────

  logCostEvent(data: { agent_id: string; run_id?: string; input_tokens: number; output_tokens: number; cost_cents: number }): void {
    this.db.prepare(`
      INSERT INTO cost_events (agent_id, run_id, input_tokens, output_tokens, cost_cents)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.agent_id, data.run_id ?? null, data.input_tokens, data.output_tokens, data.cost_cents);
  }

  getMonthlySpend(agentId: string): number {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(cost_cents), 0) as total
      FROM cost_events
      WHERE agent_id = ? AND created_at >= ?
    `).get(agentId, monthStart) as { total: number };
    return row.total;
  }

  // ─── Budget Policies ──────────────────────────────────────────

  getBudgetPolicy(agentId: string): BudgetPolicyRow | undefined {
    // Check agent-specific policy first, then global
    const agentPolicy = this.db.prepare(`
      SELECT * FROM budget_policies WHERE scope = 'agent' AND scope_id = ?
    `).get(agentId) as BudgetPolicyRow | undefined;
    if (agentPolicy) return agentPolicy;

    return this.db.prepare(`
      SELECT * FROM budget_policies WHERE scope = 'global'
    `).get() as BudgetPolicyRow | undefined;
  }

  // ─── Approvals ────────────────────────────────────────────────

  createApproval(data: { id: string; agent_id: string; type: string; context: string }): ApprovalRow {
    this.db.prepare(`
      INSERT INTO approvals (id, agent_id, type, context)
      VALUES (?, ?, ?, ?)
    `).run(data.id, data.agent_id, data.type, data.context);
    return this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(data.id) as ApprovalRow;
  }

  getApprovals(opts?: { status?: string; agentId?: string; limit?: number; offset?: number }): ApprovalRow[] {
    const { status, agentId, limit = 50, offset = 0 } = opts ?? {};
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (status) { conditions.push('status = ?'); params.push(status); }
    if (agentId) { conditions.push('agent_id = ?'); params.push(agentId); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, offset);
    return this.db.prepare(`SELECT * FROM approvals ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params) as ApprovalRow[];
  }

  getApproval(id: string): ApprovalRow | undefined {
    return this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  }

  resolveApproval(id: string, resolvedBy: string, status: 'approved' | 'rejected'): ApprovalRow | undefined {
    this.db.prepare(`
      UPDATE approvals SET status = ?, resolved_by = ?, resolved_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `).run(status, resolvedBy, id);
    return this.getApproval(id);
  }

  // ─── Users CRUD ────────────────────────────────────────────────

  getUsers(): UserRow[] {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
  }

  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  getUserByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
  }

  createUser(data: Omit<UserRow, 'created_at' | 'updated_at'> & { id?: string }): UserRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO users (id, email, name, avatar_url, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, data.email, data.name ?? null, data.avatar_url ?? null, data.status ?? 'active');
    return this.getUser(id)!;
  }

  updateUser(id: string, data: Partial<Omit<UserRow, 'id' | 'created_at'>>): UserRow | undefined {
    const existing = this.getUser(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getUser(id);
  }

  deleteUser(id: string): boolean {
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return result.changes > 0;
  }

  markUserOnboarded(id: string): void {
    this.db.prepare("UPDATE users SET onboarded = 1 WHERE id = ?").run(id);
  }

  isUserOnboarded(id: string): boolean {
    const row = this.db.prepare('SELECT onboarded FROM users WHERE id = ?').get(id) as { onboarded: number } | undefined;
    return row?.onboarded === 1;
  }

  // ─── Roles CRUD ───────────────────────────────────────────────

  getRoles(): RoleRow[] {
    return this.db.prepare('SELECT * FROM roles ORDER BY created_at').all() as RoleRow[];
  }

  getRole(id: string): RoleRow | undefined {
    return this.db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as RoleRow | undefined;
  }

  createRole(data: Omit<RoleRow, 'created_at'> & { id?: string }): RoleRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO roles (id, name, description, is_system)
      VALUES (?, ?, ?, ?)
    `).run(id, data.name, data.description ?? null, data.is_system ?? 0);
    return this.getRole(id)!;
  }

  updateRole(id: string, data: Partial<Omit<RoleRow, 'id' | 'created_at'>>): RoleRow | undefined {
    const existing = this.getRole(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    values.push(id);
    this.db.prepare(`UPDATE roles SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getRole(id);
  }

  deleteRole(id: string): boolean {
    const result = this.db.prepare('DELETE FROM roles WHERE id = ? AND is_system = 0').run(id);
    return result.changes > 0;
  }

  assignRole(userId: string, roleId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)
    `).run(userId, roleId);
  }

  removeRole(userId: string, roleId: string): void {
    this.db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(userId, roleId);
  }

  getUserRoles(userId: string): RoleRow[] {
    return this.db.prepare(`
      SELECT r.* FROM roles r
      JOIN user_roles ur ON ur.role_id = r.id
      WHERE ur.user_id = ?
      ORDER BY r.name
    `).all(userId) as RoleRow[];
  }

  // ─── Teams CRUD ───────────────────────────────────────────────

  getTeams(): TeamRow[] {
    return this.db.prepare('SELECT * FROM teams ORDER BY created_at').all() as TeamRow[];
  }

  getTeam(id: string): TeamRow | undefined {
    return this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as TeamRow | undefined;
  }

  createTeam(data: Omit<TeamRow, 'created_at'> & { id?: string }): TeamRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO teams (id, name, description)
      VALUES (?, ?, ?)
    `).run(id, data.name, data.description ?? null);
    return this.getTeam(id)!;
  }

  updateTeam(id: string, data: Partial<Omit<TeamRow, 'id' | 'created_at'>>): TeamRow | undefined {
    const existing = this.getTeam(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    values.push(id);
    this.db.prepare(`UPDATE teams SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getTeam(id);
  }

  deleteTeam(id: string): boolean {
    const result = this.db.prepare('DELETE FROM teams WHERE id = ?').run(id);
    return result.changes > 0;
  }

  joinTeam(userId: string, teamId: string, roleInTeam?: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO user_teams (user_id, team_id, role_in_team) VALUES (?, ?, ?)
    `).run(userId, teamId, roleInTeam ?? 'member');
  }

  leaveTeam(userId: string, teamId: string): void {
    this.db.prepare('DELETE FROM user_teams WHERE user_id = ? AND team_id = ?').run(userId, teamId);
  }

  getUserTeams(userId: string): TeamRow[] {
    return this.db.prepare(`
      SELECT t.* FROM teams t
      JOIN user_teams ut ON ut.team_id = t.id
      WHERE ut.user_id = ?
      ORDER BY t.name
    `).all(userId) as TeamRow[];
  }

  getTeamMembers(teamId: string): (UserRow & { role_in_team: string })[] {
    return this.db.prepare(`
      SELECT u.*, ut.role_in_team FROM users u
      JOIN user_teams ut ON ut.user_id = u.id
      WHERE ut.team_id = ?
      ORDER BY u.name
    `).all(teamId) as (UserRow & { role_in_team: string })[];
  }

  // ─── API Keys ─────────────────────────────────────────────────

  createApiKey(userId: string, name: string, keyHash: string, keyPrefix: string, scopes?: string[]): UserApiKeyRow {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO user_api_keys (id, user_id, name, key_hash, key_prefix, scopes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, name, keyHash, keyPrefix, JSON.stringify(scopes ?? []));
    return this.db.prepare('SELECT * FROM user_api_keys WHERE id = ?').get(id) as UserApiKeyRow;
  }

  getApiKeyByHash(hash: string): UserApiKeyRow | undefined {
    return this.db.prepare('SELECT * FROM user_api_keys WHERE key_hash = ?').get(hash) as UserApiKeyRow | undefined;
  }

  getUserApiKeys(userId: string): UserApiKeyRow[] {
    return this.db.prepare('SELECT * FROM user_api_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId) as UserApiKeyRow[];
  }

  deleteApiKey(id: string): boolean {
    const result = this.db.prepare('DELETE FROM user_api_keys WHERE id = ?').run(id);
    return result.changes > 0;
  }

  touchApiKeyUsed(id: string): void {
    this.db.prepare("UPDATE user_api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id);
  }

  // ─── MCP Policies CRUD ────────────────────────────────────────

  getMcpPolicies(): McpPolicyRow[] {
    return this.db.prepare('SELECT * FROM mcp_policies ORDER BY created_at').all() as McpPolicyRow[];
  }

  getMcpPolicy(id: string): McpPolicyRow | undefined {
    return this.db.prepare('SELECT * FROM mcp_policies WHERE id = ?').get(id) as McpPolicyRow | undefined;
  }

  getMcpPoliciesByPrincipal(principalType: string, principalId: string): McpPolicyRow[] {
    return this.db.prepare(`
      SELECT * FROM mcp_policies WHERE principal_type = ? AND principal_id = ? ORDER BY created_at
    `).all(principalType, principalId) as McpPolicyRow[];
  }

  getMcpPoliciesForUser(userId: string): McpPolicyRow[] {
    return this.db.prepare(`
      SELECT DISTINCT mp.* FROM mcp_policies mp
      WHERE (mp.principal_type = 'user' AND mp.principal_id = ?)
         OR (mp.principal_type = 'role' AND mp.principal_id IN (
              SELECT role_id FROM user_roles WHERE user_id = ?
            ))
         OR (mp.principal_type = 'team' AND mp.principal_id IN (
              SELECT team_id FROM user_teams WHERE user_id = ?
            ))
      ORDER BY mp.created_at
    `).all(userId, userId, userId) as McpPolicyRow[];
  }

  createMcpPolicy(data: Omit<McpPolicyRow, 'created_at' | 'updated_at'> & { id?: string }): McpPolicyRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO mcp_policies (id, principal_type, principal_id, connection_id, access_level, allowed_tools, denied_tools, max_data_classification, rate_limit_per_hour, rate_limit_per_day)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.principal_type,
      data.principal_id,
      data.connection_id,
      data.access_level ?? 'read',
      data.allowed_tools ?? null,
      data.denied_tools ?? null,
      data.max_data_classification ?? 'internal',
      data.rate_limit_per_hour ?? null,
      data.rate_limit_per_day ?? null,
    );
    return this.getMcpPolicy(id)!;
  }

  updateMcpPolicy(id: string, data: Partial<Omit<McpPolicyRow, 'id' | 'created_at'>>): McpPolicyRow | undefined {
    const existing = this.getMcpPolicy(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE mcp_policies SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getMcpPolicy(id);
  }

  deleteMcpPolicy(id: string): boolean {
    const result = this.db.prepare('DELETE FROM mcp_policies WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Knowledge Policies CRUD ──────────────────────────────────

  getKnowledgePolicies(): KnowledgePolicyRow[] {
    return this.db.prepare('SELECT * FROM knowledge_policies ORDER BY created_at').all() as KnowledgePolicyRow[];
  }

  createKnowledgePolicy(data: Omit<KnowledgePolicyRow, 'created_at'> & { id?: string }): KnowledgePolicyRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO knowledge_policies (id, principal_type, principal_id, knowledge_source_id, access_level)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, data.principal_type, data.principal_id, data.knowledge_source_id, data.access_level ?? 'read');
    return this.db.prepare('SELECT * FROM knowledge_policies WHERE id = ?').get(id) as KnowledgePolicyRow;
  }

  getKnowledgePolicy(id: string): KnowledgePolicyRow | undefined {
    return this.db.prepare('SELECT * FROM knowledge_policies WHERE id = ?').get(id) as KnowledgePolicyRow | undefined;
  }

  updateKnowledgePolicy(id: string, data: Partial<Omit<KnowledgePolicyRow, 'id' | 'created_at'>>): KnowledgePolicyRow | undefined {
    const existing = this.getKnowledgePolicy(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    values.push(id);
    this.db.prepare(`UPDATE knowledge_policies SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getKnowledgePolicy(id);
  }

  getKnowledgePoliciesForUser(userId: string): KnowledgePolicyRow[] {
    return this.db.prepare(`
      SELECT DISTINCT kp.* FROM knowledge_policies kp
      WHERE (kp.principal_type = 'user' AND kp.principal_id = ?)
         OR (kp.principal_type = 'role' AND kp.principal_id IN (
              SELECT role_id FROM user_roles WHERE user_id = ?
            ))
         OR (kp.principal_type = 'team' AND kp.principal_id IN (
              SELECT team_id FROM user_teams WHERE user_id = ?
            ))
      ORDER BY kp.created_at
    `).all(userId, userId, userId) as KnowledgePolicyRow[];
  }

  deleteKnowledgePolicy(id: string): boolean {
    const result = this.db.prepare('DELETE FROM knowledge_policies WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Agent Policies CRUD ──────────────────────────────────────

  getAgentPolicies(): AgentPolicyRow[] {
    return this.db.prepare('SELECT * FROM agent_policies ORDER BY created_at').all() as AgentPolicyRow[];
  }

  createAgentPolicy(data: Omit<AgentPolicyRow, 'created_at'> & { id?: string }): AgentPolicyRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO agent_policies (id, principal_type, principal_id, agent_id, can_use, can_configure)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.principal_type, data.principal_id, data.agent_id, data.can_use ?? 1, data.can_configure ?? 0);
    return this.db.prepare('SELECT * FROM agent_policies WHERE id = ?').get(id) as AgentPolicyRow;
  }

  getAgentPolicy(id: string): AgentPolicyRow | undefined {
    return this.db.prepare('SELECT * FROM agent_policies WHERE id = ?').get(id) as AgentPolicyRow | undefined;
  }

  updateAgentPolicy(id: string, data: Partial<Omit<AgentPolicyRow, 'id' | 'created_at'>>): AgentPolicyRow | undefined {
    const existing = this.getAgentPolicy(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    values.push(id);
    this.db.prepare(`UPDATE agent_policies SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getAgentPolicy(id);
  }

  getAgentPoliciesForUser(userId: string): AgentPolicyRow[] {
    return this.db.prepare(`
      SELECT DISTINCT ap.* FROM agent_policies ap
      WHERE (ap.principal_type = 'user' AND ap.principal_id = ?)
         OR (ap.principal_type = 'role' AND ap.principal_id IN (
              SELECT role_id FROM user_roles WHERE user_id = ?
            ))
         OR (ap.principal_type = 'team' AND ap.principal_id IN (
              SELECT team_id FROM user_teams WHERE user_id = ?
            ))
      ORDER BY ap.created_at
    `).all(userId, userId, userId) as AgentPolicyRow[];
  }

  deleteAgentPolicy(id: string): boolean {
    const result = this.db.prepare('DELETE FROM agent_policies WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── User Connections CRUD ────────────────────────────────────

  getUserConnection(userId: string, connectionId: string): UserConnectionRow | undefined {
    return this.db.prepare(`
      SELECT * FROM user_connections WHERE user_id = ? AND connection_id = ?
    `).get(userId, connectionId) as UserConnectionRow | undefined;
  }

  getUserConnections(userId: string): UserConnectionRow[] {
    return this.db.prepare('SELECT * FROM user_connections WHERE user_id = ? ORDER BY created_at').all(userId) as UserConnectionRow[];
  }

  createUserConnection(data: Omit<UserConnectionRow, 'created_at' | 'updated_at'> & { id?: string }): UserConnectionRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO user_connections (id, user_id, connection_id, credentials, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.user_id, data.connection_id, data.credentials ?? null, data.status ?? 'disconnected', data.error_message ?? null);
    return this.db.prepare('SELECT * FROM user_connections WHERE id = ?').get(id) as UserConnectionRow;
  }

  updateUserConnection(id: string, data: Partial<Omit<UserConnectionRow, 'id' | 'created_at'>>): UserConnectionRow | undefined {
    const existing = this.db.prepare('SELECT * FROM user_connections WHERE id = ?').get(id) as UserConnectionRow | undefined;
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE user_connections SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.db.prepare('SELECT * FROM user_connections WHERE id = ?').get(id) as UserConnectionRow;
  }

  deleteUserConnection(id: string): boolean {
    const result = this.db.prepare('DELETE FROM user_connections WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Tool Classifications CRUD ────────────────────────────────

  getToolClassifications(connectionId: string): McpToolClassificationRow[] {
    return this.db.prepare('SELECT * FROM mcp_tool_classifications WHERE connection_id = ? ORDER BY tool_name').all(connectionId) as McpToolClassificationRow[];
  }

  upsertToolClassification(connectionId: string, toolName: string, classification: string, description?: string): McpToolClassificationRow {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO mcp_tool_classifications (id, connection_id, tool_name, data_classification, description)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, tool_name) DO UPDATE SET
        data_classification = excluded.data_classification,
        description = excluded.description
    `).run(id, connectionId, toolName, classification, description ?? null);
    return this.db.prepare(`
      SELECT * FROM mcp_tool_classifications WHERE connection_id = ? AND tool_name = ?
    `).get(connectionId, toolName) as McpToolClassificationRow;
  }

  deleteToolClassification(id: string): boolean {
    const result = this.db.prepare('DELETE FROM mcp_tool_classifications WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Agent Runs ────────────────────────────────────────────────

  createAgentRun(data: { id: string; agent_id: string; runtime: string; input: string }): AgentRunRow {
    this.db.prepare(`
      INSERT INTO agent_runs (id, agent_id, runtime, status, input)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(data.id, data.agent_id, data.runtime, data.input);
    return this.getAgentRun(data.id)!;
  }

  getAgentRun(id: string): AgentRunRow | undefined {
    return this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as AgentRunRow | undefined;
  }

  getAgentRuns(agentId?: string, limit = 50): AgentRunRow[] {
    if (agentId) {
      return this.db.prepare('SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, limit) as AgentRunRow[];
    }
    return this.db.prepare('SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?').all(limit) as AgentRunRow[];
  }

  updateAgentRun(id: string, data: Partial<Pick<AgentRunRow, 'status' | 'output' | 'container_id' | 'started_at' | 'completed_at' | 'duration_ms' | 'error' | 'resource_usage'>>): AgentRunRow | undefined {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
    if (fields.length === 0) return this.getAgentRun(id);
    values.push(id);
    this.db.prepare(`UPDATE agent_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getAgentRun(id);
  }

  // ─── Agent Memories CRUD ────────────────────────────────────

  createMemory(data: {
    agent_id: string;
    user_id?: string | null;
    scope?: 'global' | 'user';
    type: string;
    name: string;
    description: string;
    content: string;
    source?: string;
    stale_after_days?: number | null;
  }): AgentMemoryRow {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO agent_memories (id, agent_id, user_id, scope, type, name, description, content, source, stale_after_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.agent_id,
      data.user_id ?? null,
      data.scope ?? 'global',
      data.type,
      data.name,
      data.description,
      data.content,
      data.source ?? 'auto',
      data.stale_after_days ?? null,
    );
    return this.getMemory(id)!;
  }

  getMemory(id: string): AgentMemoryRow | undefined {
    return this.db.prepare('SELECT * FROM agent_memories WHERE id = ?').get(id) as AgentMemoryRow | undefined;
  }

  getMemories(agentId: string, opts?: { userId?: string; scope?: string; type?: string; limit?: number }): AgentMemoryRow[] {
    const conditions: string[] = ['agent_id = ?'];
    const params: unknown[] = [agentId];
    if (opts?.userId) { conditions.push('user_id = ?'); params.push(opts.userId); }
    if (opts?.scope) { conditions.push('scope = ?'); params.push(opts.scope); }
    if (opts?.type) { conditions.push('type = ?'); params.push(opts.type); }
    const limit = opts?.limit ?? 100;
    params.push(limit);
    return this.db.prepare(
      `SELECT * FROM agent_memories WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`
    ).all(...params) as AgentMemoryRow[];
  }

  searchMemories(agentId: string, queryStr: string, opts?: { userId?: string; scope?: string; limit?: number }): AgentMemoryRow[] {
    const conditions: string[] = ['agent_id = ?'];
    const params: unknown[] = [agentId];
    const likePattern = `%${queryStr}%`;
    conditions.push('(name LIKE ? OR description LIKE ? OR content LIKE ?)');
    params.push(likePattern, likePattern, likePattern);
    if (opts?.userId) { conditions.push('user_id = ?'); params.push(opts.userId); }
    if (opts?.scope === 'global') { conditions.push('scope = ?'); params.push('global'); }
    else if (opts?.scope === 'user') { conditions.push('scope = ?'); params.push('user'); }
    const limit = opts?.limit ?? 20;
    params.push(limit);
    return this.db.prepare(
      `SELECT * FROM agent_memories WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`
    ).all(...params) as AgentMemoryRow[];
  }

  updateMemory(id: string, data: Partial<Pick<AgentMemoryRow, 'name' | 'description' | 'content' | 'type' | 'scope' | 'stale_after_days'>>): AgentMemoryRow | undefined {
    const existing = this.getMemory(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE agent_memories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getMemory(id);
  }

  deleteMemory(id: string): boolean {
    const result = this.db.prepare('DELETE FROM agent_memories WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Agent Behavior Config ────────────────────────────────────

  getBehaviorConfig(agentId: string, userId?: string): AgentBehaviorConfigRow | undefined {
    if (userId) {
      const userConfig = this.db.prepare(
        'SELECT * FROM agent_behavior_config WHERE agent_id = ? AND user_id = ?'
      ).get(agentId, userId) as AgentBehaviorConfigRow | undefined;
      if (userConfig) return userConfig;
    }
    // Fall back to default (null user_id)
    return this.db.prepare(
      'SELECT * FROM agent_behavior_config WHERE agent_id = ? AND user_id IS NULL'
    ).get(agentId) as AgentBehaviorConfigRow | undefined;
  }

  setBehaviorConfig(agentId: string, userId: string | null, config: Record<string, unknown>): AgentBehaviorConfigRow {
    const configJson = JSON.stringify(config);
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO agent_behavior_config (id, agent_id, user_id, config)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, user_id) DO UPDATE SET
        config = excluded.config,
        updated_at = datetime('now')
    `).run(id, agentId, userId, configJson);
    return this.db.prepare(
      userId
        ? 'SELECT * FROM agent_behavior_config WHERE agent_id = ? AND user_id = ?'
        : 'SELECT * FROM agent_behavior_config WHERE agent_id = ? AND user_id IS NULL'
    ).get(...(userId ? [agentId, userId] : [agentId])) as AgentBehaviorConfigRow;
  }

  // ─── Communication Channels ────────────────────────────────────

  getCommunicationChannels(): CommunicationChannelRow[] {
    return this.db.prepare('SELECT * FROM communication_channels ORDER BY created_at').all() as CommunicationChannelRow[];
  }

  getCommunicationChannel(id: string): CommunicationChannelRow | undefined {
    return this.db.prepare('SELECT * FROM communication_channels WHERE id = ?').get(id) as CommunicationChannelRow | undefined;
  }

  getCommunicationChannelsByPlatform(platform: string): CommunicationChannelRow[] {
    return this.db.prepare('SELECT * FROM communication_channels WHERE platform = ? ORDER BY created_at').all(platform) as CommunicationChannelRow[];
  }

  createCommunicationChannel(data: Omit<CommunicationChannelRow, 'created_at' | 'updated_at' | 'status' | 'error_message'> & { id?: string }): CommunicationChannelRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO communication_channels (id, name, platform, direction, agent_id, config, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.name, data.platform, data.direction ?? 'bidirectional', data.agent_id ?? null, data.config ?? '{}', data.enabled ?? 1);
    return this.getCommunicationChannel(id)!;
  }

  updateCommunicationChannel(id: string, data: Partial<Omit<CommunicationChannelRow, 'id' | 'created_at'>>): CommunicationChannelRow | undefined {
    const existing = this.getCommunicationChannel(id);
    if (!existing) return undefined;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'id' || key === 'created_at') continue;
      fields.push(`${key} = ?`);
      values.push(val);
    }
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE communication_channels SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getCommunicationChannel(id);
  }

  deleteCommunicationChannel(id: string): boolean {
    const result = this.db.prepare('DELETE FROM communication_channels WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Channel Threads ──────────────────────────────────────────

  getChannelThread(channelId: string, platformThreadId: string): ChannelThreadRow | undefined {
    return this.db.prepare(
      'SELECT * FROM channel_threads WHERE channel_id = ? AND platform_thread_id = ?'
    ).get(channelId, platformThreadId) as ChannelThreadRow | undefined;
  }

  getChannelThreadsByChannel(channelId: string, limit = 50): ChannelThreadRow[] {
    return this.db.prepare(
      'SELECT * FROM channel_threads WHERE channel_id = ? ORDER BY last_message_at DESC LIMIT ?'
    ).all(channelId, limit) as ChannelThreadRow[];
  }

  createChannelThread(data: Omit<ChannelThreadRow, 'id' | 'created_at' | 'last_message_at'> & { id?: string }): ChannelThreadRow {
    const id = data.id || crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO channel_threads (id, channel_id, platform_thread_id, agent_id, chat_thread_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, data.channel_id, data.platform_thread_id, data.agent_id, data.chat_thread_id ?? null);
    return this.db.prepare('SELECT * FROM channel_threads WHERE id = ?').get(id) as ChannelThreadRow;
  }

  updateChannelThreadActivity(channelId: string, platformThreadId: string): void {
    this.db.prepare(
      "UPDATE channel_threads SET last_message_at = datetime('now') WHERE channel_id = ? AND platform_thread_id = ?"
    ).run(channelId, platformThreadId);
  }

  // ─── A2A Protocol ─────────────────────────────────────────────

  createA2ATask(data: { id: string; context_id?: string; skill_id?: string; messages?: string; metadata?: string }): A2ATaskRow {
    this.db.prepare(`
      INSERT INTO a2a_tasks (id, context_id, skill_id, messages, metadata)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.id, data.context_id ?? null, data.skill_id ?? null, data.messages ?? '[]', data.metadata ?? '{}');
    return this.getA2ATask(data.id)!;
  }

  getA2ATask(id: string): A2ATaskRow | undefined {
    return this.db.prepare('SELECT * FROM a2a_tasks WHERE id = ?').get(id) as A2ATaskRow | undefined;
  }

  getA2ATasks(contextId?: string, limit = 50, offset = 0): A2ATaskRow[] {
    if (contextId) {
      return this.db.prepare('SELECT * FROM a2a_tasks WHERE context_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(contextId, limit, offset) as A2ATaskRow[];
    }
    return this.db.prepare('SELECT * FROM a2a_tasks ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as A2ATaskRow[];
  }

  updateA2ATask(id: string, data: Partial<Pick<A2ATaskRow, 'messages' | 'artifacts' | 'metadata'>>): A2ATaskRow | undefined {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
    if (fields.length === 0) return this.getA2ATask(id);
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE a2a_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getA2ATask(id);
  }

  // ─── A2A Push Notification Configs ──────────────────────────

  createA2APushConfig(data: { id: string; task_id: string; url: string; token?: string; authentication?: string }): A2APushConfigRow {
    this.db.prepare(`
      INSERT INTO a2a_push_configs (id, task_id, url, token, authentication)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.id, data.task_id, data.url, data.token ?? null, data.authentication ?? null);
    return this.db.prepare('SELECT * FROM a2a_push_configs WHERE id = ?').get(data.id) as A2APushConfigRow;
  }

  getA2APushConfig(id: string): A2APushConfigRow | undefined {
    return this.db.prepare('SELECT * FROM a2a_push_configs WHERE id = ?').get(id) as A2APushConfigRow | undefined;
  }

  getA2APushConfigsForTask(taskId: string): A2APushConfigRow[] {
    return this.db.prepare('SELECT * FROM a2a_push_configs WHERE task_id = ?').all(taskId) as A2APushConfigRow[];
  }

  deleteA2APushConfig(id: string): boolean {
    const result = this.db.prepare('DELETE FROM a2a_push_configs WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ─── Workspaces ──────────────────────────────────────────────

  createWorkspace(data: { id: string; name: string; agent_id: string; volume_name: string }): WorkspaceRow {
    this.db.prepare(`
      INSERT INTO workspaces (id, name, agent_id, volume_name, status)
      VALUES (?, ?, ?, ?, 'created')
    `).run(data.id, data.name, data.agent_id, data.volume_name);
    return this.getWorkspace(data.id)!;
  }

  getWorkspace(id: string): WorkspaceRow | undefined {
    return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
  }

  getWorkspaceByName(name: string): WorkspaceRow | undefined {
    return this.db.prepare('SELECT * FROM workspaces WHERE name = ?').get(name) as WorkspaceRow | undefined;
  }

  getWorkspaces(agentId?: string): WorkspaceRow[] {
    if (agentId) {
      return this.db.prepare("SELECT * FROM workspaces WHERE agent_id = ? AND status != 'destroyed' ORDER BY created_at DESC")
        .all(agentId) as WorkspaceRow[];
    }
    return this.db.prepare("SELECT * FROM workspaces WHERE status != 'destroyed' ORDER BY created_at DESC")
      .all() as WorkspaceRow[];
  }

  updateWorkspace(id: string, data: Partial<Pick<WorkspaceRow, 'container_id' | 'status' | 'port_mappings' | 'insforge_project_id' | 'disk_usage_mb'>>): WorkspaceRow | undefined {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(data)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
    if (fields.length === 0) return this.getWorkspace(id);
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE workspaces SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getWorkspace(id);
  }

  touchWorkspaceActivity(id: string): void {
    this.db.prepare("UPDATE workspaces SET last_active_at = datetime('now') WHERE id = ?").run(id);
  }

  // ─── Utilities ─────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

// ─── Coding Agent System Prompt ───────────────────────────────

const CODING_AGENT_SYSTEM_PROMPT = `You are a coding agent that builds complete web applications and services from scratch. You run inside a persistent Docker workspace at /workspace with full terminal, filesystem, and network access.

## Your environment
- You are Claude Code running inside a Docker container
- All your built-in tools (Bash, Write, Read, Edit, Glob, Grep) work normally — they execute inside the container
- Your workspace at /workspace persists between conversations
- Pre-installed: Node.js 22, pnpm, git, python3, curl, ripgrep, jq

## InsForge — Your Backend Infrastructure
You have InsForge, an open-source BaaS (like Supabase), available via MCP tools. **Always use InsForge for backend needs** — never build standalone API servers or databases.

InsForge provides:
- **Database**: Postgres — create tables with \`run-raw-sql\`, query via PostgREST REST API
- **Auth**: Built-in user authentication (email/password, OAuth)
- **Storage**: File/blob storage with access control via \`create-bucket\`, \`list-buckets\`
- **Edge Functions**: Serverless TypeScript (Deno) functions via \`create-function\`, \`update-function\`
- **Realtime**: WebSocket subscriptions for live database changes

### How to use InsForge
- **MCP tools**: Call InsForge tools directly by name — do NOT use ToolSearch to find them. They are already loaded.
  - \`mcp__insforge__run-raw-sql\` — execute SQL on Postgres (e.g., CREATE TABLE, INSERT, SELECT)
  - \`mcp__insforge__get-anon-key\` — get the anonymous JWT for frontend client auth
  - \`mcp__insforge__get-table-schema\` — inspect table schema
  - \`mcp__insforge__create-function\` — create Deno edge functions
  - \`mcp__insforge__update-function\` — update edge functions
  - \`mcp__insforge__get-function\` — get edge function details
  - \`mcp__insforge__delete-function\` — delete edge function
  - \`mcp__insforge__create-bucket\` — create storage bucket
  - \`mcp__insforge__list-buckets\` — list storage buckets
  - \`mcp__insforge__delete-bucket\` — delete storage bucket
  - \`mcp__insforge__get-backend-metadata\` — get InsForge backend info
  - \`mcp__insforge__fetch-docs\` — fetch InsForge documentation
  - \`mcp__insforge__get-container-logs\` — debug InsForge services
  - \`mcp__insforge__bulk-upsert\` — bulk import data from CSV/JSON
  - \`mcp__insforge__create-deployment\` — deploy frontend apps
- **PostgREST API**: \`http://host.docker.internal:5430/TABLE_NAME\` — auto-generated REST from your Postgres tables. Use \`get-anon-key\` for the auth token.
- **JS client**: \`npm install @insforge/sdk\` then \`import { createClient } from '@insforge/sdk'\`
- **Anon key**: Use \`mcp__insforge__get-anon-key\` MCP tool to get the client key for frontend apps
- **InsForge API**: \`http://host.docker.internal:7130\` — management API (NOT for data queries)

### IMPORTANT: No standalone backends
- **NEVER** use SQLite, better-sqlite3, JSON files, Express, Hono, or any standalone database/API server
- **NEVER** write your own \`server.js\` or API layer — PostgREST at \`host.docker.internal:5430\` already gives you full CRUD REST APIs for any table you create
- Create tables with \`run-raw-sql\` MCP tool, then query them via PostgREST or the JS SDK
- For custom business logic beyond CRUD, use InsForge edge functions (\`create-function\` MCP tool)
- The frontend connects to InsForge directly — no middle layer

### Deployment architecture
- **Backend**: InsForge handles it — tables via SQL, custom logic via edge functions, auth built-in
- **Frontend**: Build static files (\`npm run build\`), then serve the \`dist/\` folder. Use \`npx serve dist -p 5173\` for production-like serving

## How to work
1. **Understand the request** — ask clarifying questions if needed
2. **Set up the backend** — create InsForge tables (\`run-raw-sql\`), edge functions, and storage buckets as needed
3. **Build the frontend** — scaffold with Vite, install @insforge/sdk, connect to InsForge
4. **Build & test** — run build, verify the app works
5. **Start serving** — serve the built frontend (\`npx serve dist -p 5173 &\`)
6. **Report back** — share what was built, the InsForge tables created, and the frontend URL

## Guidelines
- Always use InsForge for data persistence, auth, and file storage — never SQLite, JSON files, or standalone Express/Hono APIs
- Use the InsForge MCP tools (run-raw-sql, get-anon-key, create-function, etc.) — do NOT use curl to interact with InsForge
- Use TypeScript when the user doesn't specify a language
- For React apps, prefer Vite + React + TypeScript + Tailwind CSS
- Always initialize git and commit after major milestones
- Always test your code compiles/runs before reporting completion
- Exposed container ports: 3000, 3001, 4000, 5173, 8000, 8080`;
