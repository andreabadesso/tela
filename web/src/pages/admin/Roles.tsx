import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { UserCog, Plus, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, type AdminRole, type AdminTeam } from '@/lib/api';

export function AdminRoles() {
  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <UserCog className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Roles & Teams</span>
      </div>

      <div className="flex-1 overflow-hidden">
        <Tabs defaultValue="roles" className="flex h-full flex-col">
          <div className="border-b border-border px-4">
            <TabsList className="h-9">
              <TabsTrigger value="roles" className="text-xs">Roles</TabsTrigger>
              <TabsTrigger value="teams" className="text-xs">Teams</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="roles" className="flex-1 overflow-hidden mt-0">
            <RolesTab />
          </TabsContent>
          <TabsContent value="teams" className="flex-1 overflow-hidden mt-0">
            <TeamsTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function RolesTab() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [viewingRole, setViewingRole] = useState<AdminRole | null>(null);

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () => api.getRoles(),
  });

  const { data: users = [] } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.getUsers(),
    enabled: !!viewingRole,
  });

  const createMutation = useMutation({
    mutationFn: () => api.createRole({ name, description }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-roles'] });
      setCreateOpen(false);
      setName('');
      setDescription('');
    },
  });

  const roleUsers = viewingRole
    ? users.filter((u) => u.roles.some((r) => r.id === viewingRole.id))
    : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end border-b border-border px-4 py-2">
        <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3 w-3" />
          Create Role
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Name</TableHead>
              <TableHead className="text-xs">Description</TableHead>
              <TableHead className="text-xs text-center">Users</TableHead>
              <TableHead className="text-xs">Type</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                  Loading...
                </TableCell>
              </TableRow>
            ) : roles.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
                  No roles configured
                </TableCell>
              </TableRow>
            ) : (
              roles.map((role) => (
                <TableRow
                  key={role.id}
                  className="cursor-pointer hover:bg-accent/50"
                  onClick={() => setViewingRole(role)}
                >
                  <TableCell className="text-sm font-medium">{role.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{role.description}</TableCell>
                  <TableCell className="text-xs text-center">{role.user_count}</TableCell>
                  <TableCell>
                    {role.system ? (
                      <Badge variant="outline" className="text-[10px] gap-1">
                        <Shield className="h-3 w-3" />
                        System
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">Custom</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create Role Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create Role</DialogTitle>
            <DialogDescription>Add a new custom role.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. developer"
                className="h-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What can this role do?"
                className="min-h-[80px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => createMutation.mutate()} disabled={!name.trim() || createMutation.isPending}>
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Role Users Dialog */}
      <Dialog open={!!viewingRole} onOpenChange={(open) => !open && setViewingRole(null)}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Users with role: {viewingRole?.name}</DialogTitle>
            <DialogDescription>{viewingRole?.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            {roleUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No users with this role</p>
            ) : (
              roleUsers.map((u) => (
                <div key={u.id} className="flex items-center gap-2 rounded-md border border-border p-2">
                  {u.image ? (
                    <img src={u.image} alt={u.name} className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                      {u.name?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{u.name}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{u.email}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TeamsTab() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [managingTeam, setManagingTeam] = useState<AdminTeam | null>(null);
  const [memberSearch, setMemberSearch] = useState('');
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());

  const { data: teams = [], isLoading } = useQuery({
    queryKey: ['admin-teams'],
    queryFn: () => api.getTeams(),
  });

  const { data: allUsers = [] } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.getUsers(),
    enabled: !!managingTeam,
  });

  const createMutation = useMutation({
    mutationFn: () => api.createTeam({ name, description }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-teams'] });
      setCreateOpen(false);
      setName('');
      setDescription('');
    },
  });

  const updateMembersMutation = useMutation({
    mutationFn: () => {
      if (!managingTeam) return Promise.resolve({ ok: true });
      return api.updateTeamMembers(managingTeam.id, Array.from(selectedMemberIds));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-teams'] });
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setManagingTeam(null);
    },
  });

  function openManage(team: AdminTeam) {
    setManagingTeam(team);
    setMemberSearch('');
    // Pre-select current members
    const memberIds = new Set(
      (team.members ?? []).map((m) => m.id)
    );
    // Fallback: check all users for this team
    if (memberIds.size === 0 && allUsers.length > 0) {
      for (const u of allUsers) {
        if (u.teams.some((t) => t.id === team.id)) {
          memberIds.add(u.id);
        }
      }
    }
    setSelectedMemberIds(memberIds);
  }

  const filteredUsers = allUsers.filter((u) => {
    if (!memberSearch) return true;
    const q = memberSearch.toLowerCase();
    return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end border-b border-border px-4 py-2">
        <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3 w-3" />
          Create Team
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Name</TableHead>
              <TableHead className="text-xs">Description</TableHead>
              <TableHead className="text-xs text-center">Members</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-8">
                  Loading...
                </TableCell>
              </TableRow>
            ) : teams.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-8">
                  No teams configured
                </TableCell>
              </TableRow>
            ) : (
              teams.map((team) => (
                <TableRow
                  key={team.id}
                  className="cursor-pointer hover:bg-accent/50"
                  onClick={() => openManage(team)}
                >
                  <TableCell className="text-sm font-medium">{team.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{team.description}</TableCell>
                  <TableCell className="text-xs text-center">{team.member_count}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create Team Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create Team</DialogTitle>
            <DialogDescription>Add a new team.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Engineering"
                className="h-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe this team"
                className="min-h-[80px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => createMutation.mutate()} disabled={!name.trim() || createMutation.isPending}>
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage Members Dialog */}
      <Dialog open={!!managingTeam} onOpenChange={(open) => !open && setManagingTeam(null)}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Manage Members: {managingTeam?.name}</DialogTitle>
            <DialogDescription>Click users to add or remove them from this team.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Input
              placeholder="Search users..."
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              className="h-8 text-sm"
            />
            <div className="max-h-64 overflow-y-auto space-y-1">
              {filteredUsers.map((u) => {
                const isMember = selectedMemberIds.has(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => {
                      setSelectedMemberIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(u.id)) next.delete(u.id);
                        else next.add(u.id);
                        return next;
                      });
                    }}
                    className={`flex w-full items-center gap-2 rounded-md border p-2 text-left transition-colors ${
                      isMember
                        ? 'border-primary bg-primary/10'
                        : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    {u.image ? (
                      <img src={u.image} alt={u.name} className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                        {u.name?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{u.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{u.email}</p>
                    </div>
                    {isMember && (
                      <Badge variant="default" className="text-[10px] shrink-0">Member</Badge>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManagingTeam(null)}>Cancel</Button>
            <Button onClick={() => updateMembersMutation.mutate()} disabled={updateMembersMutation.isPending}>
              {updateMembersMutation.isPending ? 'Saving...' : 'Save Members'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
