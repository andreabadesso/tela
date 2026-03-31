const API_BASE = '/api';

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('api_token') ?? '';
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || res.statusText);
  }
  return res.json();
}

export const api = {
  // Chat
  sendMessage: (text: string, agentId?: string) =>
    fetchApi<{ text: string; toolCalls: unknown[]; durationMs: number }>('/chat', {
      method: 'POST',
      body: JSON.stringify({ text, agentId }),
    }),

  // Conversations
  getConversations: (limit = 50, offset = 0) =>
    fetchApi<{ conversations: unknown[]; total: number }>(`/conversations?limit=${limit}&offset=${offset}`),

  getConversation: (id: number) =>
    fetchApi<unknown>(`/conversations/${id}`),

  deleteConversation: (id: number) =>
    fetchApi<{ ok: boolean }>(`/conversations/${id}`, { method: 'DELETE' }),

  // Agents
  getAgents: () => fetchApi<{ id: string; name: string; description?: string }[]>('/agents'),
  getAgent: (id: string) => fetchApi<unknown>(`/agents/${id}`),
  createAgent: (data: unknown) => fetchApi<unknown>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: unknown) => fetchApi<unknown>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (id: string) => fetchApi<{ ok: boolean }>(`/agents/${id}`, { method: 'DELETE' }),

  // Chat Threads
  getThreads: (agentId?: string) =>
    fetchApi<ChatThread[]>(`/threads${agentId ? `?agent_id=${agentId}` : ''}`),
  getThread: (id: string) =>
    fetchApi<ChatThread & { messages: ChatMsg[] }>(`/threads/${id}`),
  createThread: (agentId: string, title?: string) =>
    fetchApi<ChatThread>('/threads', { method: 'POST', body: JSON.stringify({ agent_id: agentId, title }) }),
  addMessage: (threadId: string, role: string, content: string, toolCalls?: unknown[]) =>
    fetchApi<{ id: string }>(`/threads/${threadId}/messages`, { method: 'POST', body: JSON.stringify({ role, content, tool_calls: toolCalls }) }),
  updateThread: (id: string, data: { title?: string }) =>
    fetchApi<{ ok: boolean }>(`/threads/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteThread: (id: string) =>
    fetchApi<{ ok: boolean }>(`/threads/${id}`, { method: 'DELETE' }),

  // Connections
  getConnections: () =>
    fetchApi<Connection[]>('/connections'),

  getAvailableConnections: () =>
    fetchApi<Connection[]>('/my-available-connections'),

  createConnection: (data: { name: string; type: string; config?: Record<string, unknown>; apiKey?: string; mcpServerUrl?: string }) =>
    fetchApi<Connection>('/connections', { method: 'POST', body: JSON.stringify(data) }),

  testConnection: (type: string) =>
    fetchApi<{ ok: boolean; detail?: string; error?: string }>(`/connections/${type}/test`, { method: 'POST' }),

  deleteConnection: (id: string) =>
    fetchApi<{ ok: boolean }>(`/connections/${id}`, { method: 'DELETE' }),

  getOAuthUrl: (type: string) => `${API_BASE}/connections/${type}/auth`,

  // Health
  getHealth: () => fetchApi<{ status: string; uptime: number; version?: string }>('/health'),

  // Audit Log
  getAuditLog: (params?: { limit?: number; offset?: number; agent_id?: string; action?: string; source?: string; from?: string; to?: string; user_id?: string }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    if (params?.agent_id) qs.set('agent_id', params.agent_id);
    if (params?.action) qs.set('action', params.action);
    if (params?.source) qs.set('source', params.source);
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.user_id) qs.set('user_id', params.user_id);
    const q = qs.toString();
    return fetchApi<{ entries: AuditEntry[]; total: number; limit: number; offset: number }>(`/audit${q ? `?${q}` : ''}`);
  },

  // Settings
  getSettings: () => fetchApi<SettingEntry[]>('/settings'),
  getSetting: (key: string) => fetchApi<{ key: string; value: string }>(`/settings/${key}`),
  setSetting: (key: string, value: string) =>
    fetchApi<{ key: string; value: string }>(`/settings/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  deleteSetting: (key: string) =>
    fetchApi<{ ok: boolean }>(`/settings/${key}`, { method: 'DELETE' }),

  // Knowledge Sources
  getKnowledgeSources: () =>
    fetchApi<KnowledgeSource[]>('/knowledge'),

  createKnowledgeSource: (data: { name: string; type: string; config: Record<string, unknown> }) =>
    fetchApi<KnowledgeSource>('/knowledge', { method: 'POST', body: JSON.stringify(data) }),

  updateKnowledgeSource: (id: string, data: { name?: string; type?: string; config?: Record<string, unknown> }) =>
    fetchApi<KnowledgeSource>(`/knowledge/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  deleteKnowledgeSource: (id: string) =>
    fetchApi<{ ok: boolean }>(`/knowledge/${id}`, { method: 'DELETE' }),

  syncKnowledgeSource: (id: string) =>
    fetchApi<{ added: number; updated: number; deleted: number }>(`/knowledge/${id}/sync`, { method: 'POST' }),

  getKnowledgeSourceStatus: (id: string) =>
    fetchApi<KnowledgeSourceStatus>(`/knowledge/${id}/status`),

  searchKnowledge: (query: string, opts?: { sources?: string[]; maxResults?: number }) =>
    fetchApi<{ results: KnowledgeSearchResult[] }>('/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({ query, ...opts }),
    }),

  // Knowledge — enhanced
  scanVaultPath: (path: string) =>
    fetchApi<VaultScanResult>('/knowledge/scan', { method: 'POST', body: JSON.stringify({ path }) }),

  getKnowledgeFolders: (id: string) =>
    fetchApi<FolderTree>(`/knowledge/${id}/folders`),

  getKnowledgeTags: (id: string) =>
    fetchApi<TagCount[]>(`/knowledge/${id}/tags`),

  getKnowledgeFiles: (id: string, opts?: { folder?: string; tag?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.folder) qs.set('folder', opts.folder);
    if (opts?.tag) qs.set('tag', opts.tag);
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.offset) qs.set('offset', String(opts.offset));
    return fetchApi<{ files: KnowledgeFile[]; total: number }>(`/knowledge/${id}/files?${qs}`);
  },

  getKnowledgeFile: (id: string, path: string) =>
    fetchApi<{ content: string; frontmatter: Record<string, unknown> }>(`/knowledge/${id}/file?path=${encodeURIComponent(path)}`),

  // Schedules
  getSchedules: () => fetchApi<Schedule[]>('/schedules'),
  getSchedule: (id: string) => fetchApi<Schedule>(`/schedules/${id}`),
  createSchedule: (data: Partial<Schedule>) =>
    fetchApi<Schedule>('/schedules', { method: 'POST', body: JSON.stringify(data) }),
  updateSchedule: (id: string, data: Partial<Schedule>) =>
    fetchApi<Schedule>(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSchedule: (id: string) =>
    fetchApi<{ ok: boolean }>(`/schedules/${id}`, { method: 'DELETE' }),
  runSchedule: (id: string) =>
    fetchApi<{ ok: boolean; result: string }>(`/schedules/${id}/run`, { method: 'POST' }),
  getScheduleHistory: (id: string) =>
    fetchApi<ScheduleRun[]>(`/schedules/${id}/history`),
  getScheduleTemplates: () =>
    fetchApi<ScheduleTemplate[]>('/schedule-templates'),

  // User Connections (delegated OAuth)
  getMyConnections: () =>
    fetchApi<UserConnection[]>('/me/connections'),

  initiateUserOAuth: (connectionId: string) =>
    fetchApi<{ authUrl: string }>(`/connections/${connectionId}/auth/user`, { method: 'POST' }),

  testUserConnection: (connectionId: string) =>
    fetchApi<{ ok: boolean; detail?: string; error?: string }>(`/connections/${connectionId}/test/user`, { method: 'POST' }),

  disconnectUserConnection: (connectionId: string) =>
    fetchApi<{ ok: boolean }>(`/me/connections/${connectionId}`, { method: 'DELETE' }),

  // Setup & Onboarding
  getSetupStatus: () =>
    fetchApi<{ setupCompleted: boolean }>('/setup/status'),

  completeSetup: (data?: { companyName?: string; timezone?: string; defaultModel?: string }) =>
    fetchApi<{ ok: boolean }>('/setup/complete', { method: 'POST', body: JSON.stringify(data || {}) }),

  getOnboarding: () =>
    fetchApi<OnboardingStatus>('/onboarding'),

  completeOnboarding: () =>
    fetchApi<{ ok: boolean }>('/onboarding/complete', { method: 'POST', body: JSON.stringify({}) }),

  // Admin — Users
  getUsers: () => fetchApi<AdminUser[]>('/admin/users'),
  updateUser: (id: string, data: Partial<AdminUser>) =>
    fetchApi<AdminUser>(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  assignUserRole: (userId: string, roleId: string) =>
    fetchApi<{ ok: boolean }>(`/admin/users/${userId}/roles`, { method: 'POST', body: JSON.stringify({ roleId }) }),
  removeUserRole: (userId: string, roleId: string) =>
    fetchApi<{ ok: boolean }>(`/admin/users/${userId}/roles/${roleId}`, { method: 'DELETE' }),
  assignUserTeam: (userId: string, teamId: string) =>
    fetchApi<{ ok: boolean }>(`/admin/users/${userId}/teams`, { method: 'POST', body: JSON.stringify({ teamId }) }),
  removeUserTeam: (userId: string, teamId: string) =>
    fetchApi<{ ok: boolean }>(`/admin/users/${userId}/teams/${teamId}`, { method: 'DELETE' }),

  // Admin — Roles & Teams
  getRoles: () => fetchApi<AdminRole[]>('/admin/roles'),
  createRole: (data: { name: string; description: string }) =>
    fetchApi<AdminRole>('/admin/roles', { method: 'POST', body: JSON.stringify(data) }),
  getTeams: () => fetchApi<AdminTeam[]>('/admin/teams'),
  createTeam: (data: { name: string; description: string }) =>
    fetchApi<AdminTeam>('/admin/teams', { method: 'POST', body: JSON.stringify(data) }),
  updateTeamMembers: (teamId: string, userIds: string[]) =>
    fetchApi<{ ok: boolean }>(`/admin/teams/${teamId}/members`, { method: 'PUT', body: JSON.stringify({ userIds }) }),

  // Admin — MCP Policies
  getMcpPolicies: () => fetchApi<McpPolicy[]>('/admin/policies/mcp'),
  createMcpPolicy: (data: Partial<McpPolicy>) =>
    fetchApi<McpPolicy>('/admin/policies/mcp', { method: 'POST', body: JSON.stringify(data) }),
  updateMcpPolicy: (id: string, data: Partial<McpPolicy>) =>
    fetchApi<McpPolicy>(`/admin/policies/mcp/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteMcpPolicy: (id: string) =>
    fetchApi<{ ok: boolean }>(`/admin/policies/mcp/${id}`, { method: 'DELETE' }),

  // Admin — Knowledge Policies
  getKnowledgePolicies: () => fetchApi<KnowledgePolicy[]>('/admin/policies/knowledge'),
  createKnowledgePolicy: (data: Partial<KnowledgePolicy>) =>
    fetchApi<KnowledgePolicy>('/admin/policies/knowledge', { method: 'POST', body: JSON.stringify(data) }),
  updateKnowledgePolicy: (id: string, data: Partial<KnowledgePolicy>) =>
    fetchApi<KnowledgePolicy>(`/admin/policies/knowledge/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteKnowledgePolicy: (id: string) =>
    fetchApi<{ ok: boolean }>(`/admin/policies/knowledge/${id}`, { method: 'DELETE' }),

  // Admin — Agent Policies
  getAgentPolicies: () => fetchApi<AgentPolicy[]>('/admin/policies/agents'),
  createAgentPolicy: (data: Partial<AgentPolicy>) =>
    fetchApi<AgentPolicy>('/admin/policies/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgentPolicy: (id: string, data: Partial<AgentPolicy>) =>
    fetchApi<AgentPolicy>(`/admin/policies/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgentPolicy: (id: string) =>
    fetchApi<{ ok: boolean }>(`/admin/policies/agents/${id}`, { method: 'DELETE' }),
};

export interface AuditEntry {
  id: number;
  agent_id: string | null;
  action: string;
  details: string;
  source: string;
  duration_ms: number | null;
  created_at: string;
  user_id?: string | null;
  user_name?: string | null;
  user_image?: string | null;
  connection_id?: string | null;
  connection_name?: string | null;
  tool_name?: string | null;
  access_decision?: 'allowed' | 'denied' | 'rate_limited' | null;
}

export interface SettingEntry {
  key: string;
  value: string;
  updated_at: string;
}

export interface Connection {
  id: string;
  name: string;
  type: string;
  status: string;
  config: string;
  mcp_server_url: string | null;
  token_strategy: 'company' | 'team' | 'user';
  team_id: string | null;
  last_sync_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSource {
  id: string;
  name: string;
  type: string;
  config: string;
  status: string;
  last_sync_at: string | null;
  doc_count: number;
  error_message: string | null;
  connected: boolean;
  liveDocCount: number;
  liveError?: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSourceStatus {
  id: string;
  name: string;
  type: string;
  status: string;
  connected: boolean;
  lastSync: string | null;
  docCount: number;
  error?: string;
}

export interface KnowledgeSearchResult {
  path: string;
  content: string;
  metadata: {
    source: string;
    lastModified: string;
    author?: string;
    tags?: string[];
  };
}

export interface Schedule {
  id: string;
  name: string;
  cron_expression: string;
  agent_id: string;
  prompt: string;
  notification_channels: string;
  enabled: number;
  last_run_at: string | null;
  last_result: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleRun {
  id: number;
  job_name: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  output: string | null;
  error: string | null;
}

export interface ScheduleTemplate {
  name: string;
  cron_expression: string;
  prompt: string;
}

export interface ChatThread {
  id: string;
  user_id: string;
  agent_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMsg {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  created_at: string;
}

// User Connection types

export interface UserConnection {
  id: string;
  name: string;
  type: string;
  token_strategy: 'company' | 'delegated';
  company_status: string;
  user_status: string;
  user_connection_id: string | null;
  error_message: string | null;
  mcp_server_url: string | null;
}

export interface OnboardingStatus {
  onboarded: boolean;
  role: string;
  roles: string[];
  teams: string[];
  tools: { name: string; type: string }[];
}

// Admin types

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  status: 'active' | 'suspended';
  roles: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  last_active_at: string | null;
  created_at: string;
}

export interface AdminRole {
  id: string;
  name: string;
  description: string;
  user_count: number;
  system: boolean;
  created_at: string;
}

export interface AdminTeam {
  id: string;
  name: string;
  description: string;
  member_count: number;
  members?: { id: string; name: string; email: string; image?: string | null }[];
  created_at: string;
}

export interface McpPolicy {
  id: string;
  principal_type: 'role' | 'team' | 'user';
  principal_id: string;
  principal_name: string;
  connection_id: string;
  connection_name: string;
  access_level: 'none' | 'read' | 'write' | 'admin';
  allowed_tools: string[];
  denied_tools: string[];
  rate_limit_hour: number | null;
  rate_limit_day: number | null;
  created_at: string;
}

export interface KnowledgePolicy {
  id: string;
  principal_type: 'role' | 'team' | 'user';
  principal_id: string;
  principal_name: string;
  knowledge_source_id: string;
  knowledge_source_name: string;
  access_level: 'none' | 'read' | 'write';
  created_at: string;
}

export interface AgentPolicy {
  id: string;
  principal_type: 'role' | 'team' | 'user';
  principal_id: string;
  principal_name: string;
  agent_id: string;
  agent_name: string;
  can_use: boolean;
  can_configure: boolean;
  created_at: string;
}

// Knowledge — enhanced types

export interface VaultScanResult {
  totalFiles: number;
  totalFolders: number;
  sizeBytes: number;
  folders: FolderNode[];
}

export interface FolderNode {
  path: string;
  name: string;
  fileCount: number;
  children: FolderNode[];
}

export type FolderTree = FolderNode[];

export interface TagCount {
  tag: string;
  count: number;
}

export interface KnowledgeFile {
  path: string;
  name: string;
  folder: string;
  size: number;
  lastModified: string;
  tags: string[];
}
