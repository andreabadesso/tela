import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ShieldCheck, Plus, Pencil, Trash2, Users, Building2, User,
  Lock, Eye, PenLine, Crown, Info, ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card } from '@/components/ui/card';
import {
  api,
  type McpPolicy, type KnowledgePolicy, type AgentPolicy,
  type AdminRole, type AdminTeam, type AdminUser,
} from '@/lib/api';
import { cn } from '@/lib/utils';

// ─── Shared components ────────────────────────────────────────

const ACCESS_LEVELS = [
  { value: 'none', label: 'No Access', icon: Lock, color: 'text-zinc-400', bg: 'bg-zinc-500/10 border-zinc-500/20', desc: 'Completely blocked' },
  { value: 'read', label: 'Read Only', icon: Eye, color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20', desc: 'View data, no changes' },
  { value: 'write', label: 'Read & Write', icon: PenLine, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', desc: 'Full CRUD operations' },
  { value: 'admin', label: 'Full Admin', icon: Crown, color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/20', desc: 'All operations + config' },
];

const PRINCIPAL_TYPES = [
  { value: 'role', label: 'Role', icon: ShieldCheck, desc: 'Applies to everyone with this role' },
  { value: 'team', label: 'Team', icon: Building2, desc: 'Applies to all team members' },
  { value: 'user', label: 'User', icon: User, desc: 'Applies to a specific person' },
];

function AccessBadge({ level }: { level: string }) {
  const config = ACCESS_LEVELS.find((a) => a.value === level);
  if (!config) return <Badge variant="outline">{level}</Badge>;
  const Icon = config.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium', config.bg, config.color)}>
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  );
}

function PrincipalBadge({ type, name }: { type: string; name: string }) {
  const config = PRINCIPAL_TYPES.find((p) => p.value === type);
  const Icon = config?.icon ?? Users;
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-6 w-6 items-center justify-center rounded bg-muted">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div>
        <span className="text-sm font-medium">{name}</span>
        <span className="text-[10px] text-muted-foreground ml-1.5">({type})</span>
      </div>
    </div>
  );
}

function AccessLevelPicker({ value, onChange, showNone = true }: { value: string; onChange: (v: string) => void; showNone?: boolean }) {
  const levels = showNone ? ACCESS_LEVELS : ACCESS_LEVELS.filter((a) => a.value !== 'none');
  return (
    <div className="grid grid-cols-2 gap-2">
      {levels.map((level) => {
        const Icon = level.icon;
        const selected = value === level.value;
        return (
          <button
            key={level.value}
            type="button"
            onClick={() => onChange(level.value)}
            className={cn(
              'flex flex-col items-start gap-0.5 rounded-lg border p-2.5 text-left transition-all',
              selected ? cn(level.bg, 'ring-1 ring-offset-1 ring-offset-background', level.color.replace('text-', 'ring-')) : 'border-border hover:border-muted-foreground/30',
            )}
          >
            <div className="flex items-center gap-1.5">
              <Icon className={cn('h-3.5 w-3.5', selected ? level.color : 'text-muted-foreground')} />
              <span className={cn('text-xs font-medium', selected ? level.color : 'text-foreground')}>{level.label}</span>
            </div>
            <span className="text-[10px] text-muted-foreground">{level.desc}</span>
          </button>
        );
      })}
    </div>
  );
}

function PrincipalPicker({
  type, principalId, onTypeChange, onIdChange, roles, teams, users,
}: {
  type: string;
  principalId: string;
  onTypeChange: (t: string) => void;
  onIdChange: (id: string) => void;
  roles: AdminRole[];
  teams: AdminTeam[];
  users: AdminUser[];
}) {
  const options = type === 'role' ? roles.map((r) => ({ id: r.id, name: r.name }))
    : type === 'team' ? teams.map((t) => ({ id: t.id, name: t.name }))
    : users.map((u) => ({ id: u.id, name: u.name }));

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs text-muted-foreground mb-2 block">Apply this policy to a...</Label>
        <div className="flex gap-2">
          {PRINCIPAL_TYPES.map((pt) => {
            const Icon = pt.icon;
            return (
              <button
                key={pt.value}
                type="button"
                onClick={() => { onTypeChange(pt.value); onIdChange(''); }}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                  type === pt.value ? 'bg-accent text-accent-foreground border-accent' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {pt.label}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground mb-1.5 block">
          Select {type}
        </Label>
        <Select value={principalId} onValueChange={onIdChange}>
          <SelectTrigger className="h-9 text-sm">
            <SelectValue placeholder={`Choose a ${type}...`} />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function usePrincipals() {
  const { data: roles = [] } = useQuery<AdminRole[]>({ queryKey: ['admin-roles'], queryFn: () => api.getRoles() });
  const { data: teams = [] } = useQuery<AdminTeam[]>({ queryKey: ['admin-teams'], queryFn: () => api.getTeams() });
  const { data: users = [] } = useQuery<AdminUser[]>({ queryKey: ['admin-users'], queryFn: () => api.getUsers() });
  return { roles, teams, users };
}

function EmptyState({ icon: Icon, title, description }: { icon: typeof ShieldCheck; title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <Icon className="h-10 w-10 mb-3 opacity-20" />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs mt-1 max-w-xs text-center">{description}</p>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────

export function AdminPolicies() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Access Policies</span>
      </div>

      <div className="flex-1 overflow-hidden">
        <Tabs defaultValue="mcp" className="flex h-full flex-col">
          <div className="border-b border-border px-4">
            <TabsList className="h-9">
              <TabsTrigger value="mcp" className="text-xs">MCP Connections</TabsTrigger>
              <TabsTrigger value="knowledge" className="text-xs">Knowledge</TabsTrigger>
              <TabsTrigger value="agents" className="text-xs">Agents</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="mcp" className="flex-1 overflow-hidden mt-0">
            <McpPoliciesTab />
          </TabsContent>
          <TabsContent value="knowledge" className="flex-1 overflow-hidden mt-0">
            <KnowledgePoliciesTab />
          </TabsContent>
          <TabsContent value="agents" className="flex-1 overflow-hidden mt-0">
            <AgentPoliciesTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// ─── MCP Policies ─────────────────────────────────────────────

function McpPoliciesTab() {
  const queryClient = useQueryClient();
  const { roles, teams, users } = usePrincipals();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [principalType, setPrincipalType] = useState('role');
  const [principalId, setPrincipalId] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [accessLevel, setAccessLevel] = useState('read');
  const [allowedTools, setAllowedTools] = useState('');
  const [rateLimitHour, setRateLimitHour] = useState('');
  const [rateLimitDay, setRateLimitDay] = useState('');

  const { data: policies = [], isLoading } = useQuery({ queryKey: ['admin-mcp-policies'], queryFn: () => api.getMcpPolicies() });
  const { data: connections = [] } = useQuery({ queryKey: ['connections'], queryFn: () => api.getConnections() });

  const saveMutation = useMutation({
    mutationFn: (data: Partial<McpPolicy>) => editingId ? api.updateMcpPolicy(editingId, data) : api.createMcpPolicy(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin-mcp-policies'] }); closeDialog(); },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteMcpPolicy(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-mcp-policies'] }),
  });

  function closeDialog() { setDialogOpen(false); setEditingId(null); resetForm(); }
  function resetForm() { setPrincipalType('role'); setPrincipalId(''); setConnectionId(''); setAccessLevel('read'); setAllowedTools(''); setRateLimitHour(''); setRateLimitDay(''); }

  function openEdit(p: McpPolicy) {
    setEditingId(p.id); setPrincipalType(p.principal_type); setPrincipalId(p.principal_id);
    setConnectionId(p.connection_id); setAccessLevel(p.access_level);
    setAllowedTools(p.allowed_tools?.join(', ') ?? '');
    setRateLimitHour(p.rate_limit_hour?.toString() ?? ''); setRateLimitDay(p.rate_limit_day?.toString() ?? '');
    setDialogOpen(true);
  }

  function handleSave() {
    saveMutation.mutate({
      principal_type: principalType as McpPolicy['principal_type'],
      principal_id: principalId,
      connection_id: connectionId,
      access_level: accessLevel as McpPolicy['access_level'],
      allowed_tools: allowedTools ? allowedTools.split(',').map((s) => s.trim()).filter(Boolean) : [],
      rate_limit_hour: rateLimitHour ? parseInt(rateLimitHour) : null,
      rate_limit_day: rateLimitDay ? parseInt(rateLimitDay) : null,
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">Control who can access which MCP connections and tools</p>
        <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => { resetForm(); setDialogOpen(true); }}>
          <Plus className="h-3 w-3" />
          Add Policy
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">Loading...</div>
        ) : policies.length === 0 ? (
          <EmptyState
            icon={ShieldAlert}
            title="No MCP policies yet"
            description="Add policies to control which roles, teams, or users can access your connected tools. Without policies, no one has MCP access (except admins)."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Who</TableHead>
                <TableHead className="text-xs">Connection</TableHead>
                <TableHead className="text-xs">Access</TableHead>
                <TableHead className="text-xs">Tools</TableHead>
                <TableHead className="text-xs">Rate Limit</TableHead>
                <TableHead className="text-xs w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {policies.map((p) => (
                <TableRow key={p.id}>
                  <TableCell><PrincipalBadge type={p.principal_type} name={p.principal_name} /></TableCell>
                  <TableCell className="text-sm font-medium">{p.connection_name}</TableCell>
                  <TableCell><AccessBadge level={p.access_level} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-32 truncate">
                    {p.allowed_tools?.length ? p.allowed_tools.join(', ') : <span className="text-emerald-400/60">All tools</span>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {p.rate_limit_hour || p.rate_limit_day
                      ? [p.rate_limit_hour && `${p.rate_limit_hour}/hr`, p.rate_limit_day && `${p.rate_limit_day}/day`].filter(Boolean).join(' · ')
                      : <span className="opacity-40">Unlimited</span>}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-0.5">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(p)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => { if (confirm('Delete this policy?')) deleteMutation.mutate(p.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit MCP Policy' : 'New MCP Policy'}</DialogTitle>
            <DialogDescription>Define who can access which connection and what they can do.</DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Who */}
            <PrincipalPicker
              type={principalType} principalId={principalId}
              onTypeChange={setPrincipalType} onIdChange={setPrincipalId}
              roles={roles} teams={teams} users={users}
            />

            {/* Which connection */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Connection</Label>
              {connections.length === 0 ? (
                <Card className="p-3 border-dashed">
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Info className="h-3.5 w-3.5" />
                    No connections yet. Go to Connections to add one first.
                  </p>
                </Card>
              ) : (
                <Select value={connectionId} onValueChange={setConnectionId}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Choose a connection..." />
                  </SelectTrigger>
                  <SelectContent>
                    {connections.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <div className="flex items-center gap-2">
                          <span>{c.name}</span>
                          <Badge variant="outline" className="text-[10px]">{c.type}</Badge>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Access level */}
            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">Access Level</Label>
              <AccessLevelPicker value={accessLevel} onChange={setAccessLevel} />
            </div>

            {/* Advanced: tools + rate limits */}
            {accessLevel !== 'none' && (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <p className="text-xs font-medium text-muted-foreground">Advanced (optional)</p>
                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">
                    Restrict to specific tools
                  </Label>
                  <Input
                    value={allowedTools}
                    onChange={(e) => setAllowedTools(e.target.value)}
                    placeholder="Leave empty for all tools, or: search, list_issues, get_user"
                    className="h-8 text-xs font-mono"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">Comma-separated tool names. Empty = all tools allowed.</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1 block">Max calls / hour</Label>
                    <Input type="number" value={rateLimitHour} onChange={(e) => setRateLimitHour(e.target.value)} placeholder="Unlimited" className="h-8 text-xs" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1 block">Max calls / day</Label>
                    <Input type="number" value={rateLimitDay} onChange={(e) => setRateLimitDay(e.target.value)} placeholder="Unlimited" className="h-8 text-xs" />
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Cancel</Button>
            <Button onClick={handleSave} disabled={!principalId || !connectionId || saveMutation.isPending}>
              {saveMutation.isPending ? 'Saving...' : editingId ? 'Save Changes' : 'Create Policy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Knowledge Policies ───────────────────────────────────────

function KnowledgePoliciesTab() {
  const queryClient = useQueryClient();
  const { roles, teams, users } = usePrincipals();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [principalType, setPrincipalType] = useState('role');
  const [principalId, setPrincipalId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [accessLevel, setAccessLevel] = useState('read');

  const { data: policies = [], isLoading } = useQuery({ queryKey: ['admin-knowledge-policies'], queryFn: () => api.getKnowledgePolicies() });
  const { data: sources = [] } = useQuery({ queryKey: ['knowledge-sources'], queryFn: () => api.getKnowledgeSources() });

  const saveMutation = useMutation({
    mutationFn: (data: Partial<KnowledgePolicy>) => editingId ? api.updateKnowledgePolicy(editingId, data) : api.createKnowledgePolicy(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin-knowledge-policies'] }); closeDialog(); },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteKnowledgePolicy(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-knowledge-policies'] }),
  });

  function closeDialog() { setDialogOpen(false); setEditingId(null); setPrincipalType('role'); setPrincipalId(''); setSourceId(''); setAccessLevel('read'); }
  function openEdit(p: KnowledgePolicy) { setEditingId(p.id); setPrincipalType(p.principal_type); setPrincipalId(p.principal_id); setSourceId(p.knowledge_source_id); setAccessLevel(p.access_level); setDialogOpen(true); }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">Control who can read or write to knowledge sources</p>
        <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => { closeDialog(); setDialogOpen(true); }}>
          <Plus className="h-3 w-3" />
          Add Policy
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">Loading...</div>
        ) : policies.length === 0 ? (
          <EmptyState icon={ShieldAlert} title="No knowledge policies yet" description="Add policies to control who can access your knowledge sources." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Who</TableHead>
                <TableHead className="text-xs">Knowledge Source</TableHead>
                <TableHead className="text-xs">Access</TableHead>
                <TableHead className="text-xs w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {policies.map((p) => (
                <TableRow key={p.id}>
                  <TableCell><PrincipalBadge type={p.principal_type} name={p.principal_name} /></TableCell>
                  <TableCell className="text-sm font-medium">{p.knowledge_source_name}</TableCell>
                  <TableCell><AccessBadge level={p.access_level} /></TableCell>
                  <TableCell>
                    <div className="flex items-center gap-0.5">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(p)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => { if (confirm('Delete?')) deleteMutation.mutate(p.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Knowledge Policy' : 'New Knowledge Policy'}</DialogTitle>
            <DialogDescription>Control who can access knowledge sources.</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <PrincipalPicker type={principalType} principalId={principalId} onTypeChange={setPrincipalType} onIdChange={setPrincipalId} roles={roles} teams={teams} users={users} />
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Knowledge Source</Label>
              <Select value={sourceId} onValueChange={setSourceId}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Choose a source..." /></SelectTrigger>
                <SelectContent>{sources.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-2 block">Access Level</Label>
              <AccessLevelPicker value={accessLevel} onChange={setAccessLevel} showNone={false} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Cancel</Button>
            <Button
              onClick={() => saveMutation.mutate({ principal_type: principalType as KnowledgePolicy['principal_type'], principal_id: principalId, knowledge_source_id: sourceId, access_level: accessLevel as KnowledgePolicy['access_level'] })}
              disabled={!principalId || !sourceId || saveMutation.isPending}
            >
              {saveMutation.isPending ? 'Saving...' : editingId ? 'Save Changes' : 'Create Policy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Agent Policies ───────────────────────────────────────────

function AgentPoliciesTab() {
  const queryClient = useQueryClient();
  const { roles, teams, users } = usePrincipals();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [principalType, setPrincipalType] = useState('role');
  const [principalId, setPrincipalId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [canUse, setCanUse] = useState(true);
  const [canConfigure, setCanConfigure] = useState(false);

  const { data: policies = [], isLoading } = useQuery({ queryKey: ['admin-agent-policies'], queryFn: () => api.getAgentPolicies() });
  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: () => api.getAgents() });

  const saveMutation = useMutation({
    mutationFn: (data: Partial<AgentPolicy>) => editingId ? api.updateAgentPolicy(editingId, data) : api.createAgentPolicy(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin-agent-policies'] }); closeDialog(); },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteAgentPolicy(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-agent-policies'] }),
  });

  function closeDialog() { setDialogOpen(false); setEditingId(null); setPrincipalType('role'); setPrincipalId(''); setAgentId(''); setCanUse(true); setCanConfigure(false); }
  function openEdit(p: AgentPolicy) { setEditingId(p.id); setPrincipalType(p.principal_type); setPrincipalId(p.principal_id); setAgentId(p.agent_id); setCanUse(p.can_use); setCanConfigure(p.can_configure); setDialogOpen(true); }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">Control who can use or configure each agent</p>
        <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => { closeDialog(); setDialogOpen(true); }}>
          <Plus className="h-3 w-3" />
          Add Policy
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">Loading...</div>
        ) : policies.length === 0 ? (
          <EmptyState icon={ShieldAlert} title="No agent policies yet" description="Add policies to control which roles, teams, or users can use each agent." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Who</TableHead>
                <TableHead className="text-xs">Agent</TableHead>
                <TableHead className="text-xs text-center">Can Use</TableHead>
                <TableHead className="text-xs text-center">Can Configure</TableHead>
                <TableHead className="text-xs w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {policies.map((p) => (
                <TableRow key={p.id}>
                  <TableCell><PrincipalBadge type={p.principal_type} name={p.principal_name} /></TableCell>
                  <TableCell className="text-sm font-medium">{p.agent_name}</TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline" className={cn('text-[10px]', p.can_use ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-red-500/15 text-red-400 border-red-500/30')}>
                      {p.can_use ? 'Yes' : 'No'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline" className={cn('text-[10px]', p.can_configure ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-red-500/15 text-red-400 border-red-500/30')}>
                      {p.can_configure ? 'Yes' : 'No'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-0.5">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(p)}><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => { if (confirm('Delete?')) deleteMutation.mutate(p.id); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Agent Policy' : 'New Agent Policy'}</DialogTitle>
            <DialogDescription>Control who can use or configure agents.</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <PrincipalPicker type={principalType} principalId={principalId} onTypeChange={setPrincipalType} onIdChange={setPrincipalId} roles={roles} teams={teams} users={users} />
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Agent</Label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Choose an agent..." /></SelectTrigger>
                <SelectContent>{agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Can Use</p>
                  <p className="text-xs text-muted-foreground">Allow chatting with this agent</p>
                </div>
                <Switch checked={canUse} onCheckedChange={setCanUse} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Can Configure</p>
                  <p className="text-xs text-muted-foreground">Allow editing agent settings</p>
                </div>
                <Switch checked={canConfigure} onCheckedChange={setCanConfigure} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Cancel</Button>
            <Button
              onClick={() => saveMutation.mutate({ principal_type: principalType as AgentPolicy['principal_type'], principal_id: principalId, agent_id: agentId, can_use: canUse, can_configure: canConfigure })}
              disabled={!principalId || !agentId || saveMutation.isPending}
            >
              {saveMutation.isPending ? 'Saving...' : editingId ? 'Save Changes' : 'Create Policy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
