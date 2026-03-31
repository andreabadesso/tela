import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Users as UsersIcon, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import { api, type AdminUser } from '@/lib/api';

function formatDate(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function UserAvatar({ user }: { user: { name: string; image?: string | null } }) {
  if (user.image) {
    return (
      <img
        src={user.image}
        alt={user.name}
        className="h-7 w-7 rounded-full shrink-0"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium shrink-0">
      {user.name?.charAt(0)?.toUpperCase() || '?'}
    </div>
  );
}

export function AdminUsers() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [editStatus, setEditStatus] = useState<'active' | 'suspended'>('active');
  const [editRoleIds, setEditRoleIds] = useState<Set<string>>(new Set());
  const [editTeamIds, setEditTeamIds] = useState<Set<string>>(new Set());

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.getUsers(),
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () => api.getRoles(),
  });

  const { data: teams = [] } = useQuery({
    queryKey: ['admin-teams'],
    queryFn: () => api.getTeams(),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editingUser) return;
      // Update status
      await api.updateUser(editingUser.id, { status: editStatus });

      // Sync roles
      const currentRoleIds = new Set(editingUser.roles.map((r) => r.id));
      for (const roleId of editRoleIds) {
        if (!currentRoleIds.has(roleId)) {
          await api.assignUserRole(editingUser.id, roleId);
        }
      }
      for (const roleId of currentRoleIds) {
        if (!editRoleIds.has(roleId)) {
          await api.removeUserRole(editingUser.id, roleId);
        }
      }

      // Sync teams
      const currentTeamIds = new Set(editingUser.teams.map((t) => t.id));
      for (const teamId of editTeamIds) {
        if (!currentTeamIds.has(teamId)) {
          await api.assignUserTeam(editingUser.id, teamId);
        }
      }
      for (const teamId of currentTeamIds) {
        if (!editTeamIds.has(teamId)) {
          await api.removeUserTeam(editingUser.id, teamId);
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setEditingUser(null);
    },
  });

  function openEdit(user: AdminUser) {
    setEditingUser(user);
    setEditStatus(user.status);
    setEditRoleIds(new Set(user.roles.map((r) => r.id)));
    setEditTeamIds(new Set(user.teams.map((t) => t.id)));
  }

  const filtered = users.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
  });

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <UsersIcon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Users</span>
        <Badge variant="secondary" className="text-[10px]">
          {users.length}
        </Badge>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-sm border-0 shadow-none focus-visible:ring-0"
        />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">User</TableHead>
              <TableHead className="text-xs">Email</TableHead>
              <TableHead className="text-xs">Status</TableHead>
              <TableHead className="text-xs">Roles</TableHead>
              <TableHead className="text-xs">Teams</TableHead>
              <TableHead className="text-xs">Last Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                  Loading...
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                  {search ? 'No users match your search' : 'No users found'}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((user) => (
                <TableRow
                  key={user.id}
                  className="cursor-pointer hover:bg-accent/50"
                  onClick={() => openEdit(user)}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <UserAvatar user={user} />
                      <span className="text-sm font-medium">{user.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{user.email}</TableCell>
                  <TableCell>
                    <Badge
                      variant={user.status === 'active' ? 'default' : 'secondary'}
                      className={`text-[10px] ${
                        user.status === 'active'
                          ? 'bg-emerald-600/15 text-emerald-400 border-emerald-500/30'
                          : 'bg-red-500/15 text-red-400 border-red-500/30'
                      }`}
                    >
                      {user.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {user.roles.map((r) => (
                        <Badge key={r.id} variant="outline" className="text-[10px]">
                          {r.name}
                        </Badge>
                      ))}
                      {user.roles.length === 0 && (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {user.teams.map((t) => (
                        <Badge key={t.id} variant="outline" className="text-[10px]">
                          {t.name}
                        </Badge>
                      ))}
                      {user.teams.length === 0 && (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(user.last_active_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Edit User Dialog */}
      <Dialog open={!!editingUser} onOpenChange={(open) => !open && setEditingUser(null)}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              {editingUser?.name} ({editingUser?.email})
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Status */}
            <div className="flex items-center justify-between">
              <Label className="text-sm">Active</Label>
              <Switch
                checked={editStatus === 'active'}
                onCheckedChange={(checked) => setEditStatus(checked ? 'active' : 'suspended')}
              />
            </div>

            {/* Roles */}
            <div className="space-y-2">
              <Label className="text-sm">Roles</Label>
              <div className="flex flex-wrap gap-2">
                {roles.map((role) => (
                  <RoleToggle
                    key={role.id}
                    label={role.name}
                    active={editRoleIds.has(role.id)}
                    onToggle={() => {
                      setEditRoleIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(role.id)) next.delete(role.id);
                        else next.add(role.id);
                        return next;
                      });
                    }}
                  />
                ))}
                {roles.length === 0 && (
                  <span className="text-xs text-muted-foreground">No roles available</span>
                )}
              </div>
            </div>

            {/* Teams */}
            <div className="space-y-2">
              <Label className="text-sm">Teams</Label>
              <div className="flex flex-wrap gap-2">
                {teams.map((team) => (
                  <RoleToggle
                    key={team.id}
                    label={team.name}
                    active={editTeamIds.has(team.id)}
                    onToggle={() => {
                      setEditTeamIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(team.id)) next.delete(team.id);
                        else next.add(team.id);
                        return next;
                      });
                    }}
                  />
                ))}
                {teams.length === 0 && (
                  <span className="text-xs text-muted-foreground">No teams available</span>
                )}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingUser(null)}>
              Cancel
            </Button>
            <Button onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RoleToggle({ label, active, onToggle }: { label: string; active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
      }`}
    >
      {label}
    </button>
  );
}
