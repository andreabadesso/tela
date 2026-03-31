import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Schedule, type ScheduleTemplate } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  Plus,
  Play,
  Pause,
  Trash2,
  Edit2,
  Clock,
  RotateCw,
  ChevronDown,
  ChevronUp,
  Zap,
} from 'lucide-react';

export function Schedules() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    cron_expression: '',
    agent_id: 'default',
    prompt: '',
    notification_channels: '["telegram"]',
    enabled: 1,
  });

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ['schedules'],
    queryFn: api.getSchedules,
  });

  const { data: templates = [] } = useQuery({
    queryKey: ['schedule-templates'],
    queryFn: api.getScheduleTemplates,
  });

  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: api.getAgents,
  });

  const createMutation = useMutation({
    mutationFn: (data: Partial<Schedule>) => api.createSchedule(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      setDialogOpen(false);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Schedule> }) =>
      api.updateSchedule(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
      setDialogOpen(false);
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['schedules'] }),
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => api.runSchedule(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['schedules'] }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: number }) =>
      api.updateSchedule(id, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['schedules'] }),
  });

  function resetForm() {
    setForm({
      name: '',
      cron_expression: '',
      agent_id: 'default',
      prompt: '',
      notification_channels: '["telegram"]',
      enabled: 1,
    });
    setEditingId(null);
  }

  function openCreate(template?: ScheduleTemplate) {
    resetForm();
    if (template) {
      setForm((f) => ({
        ...f,
        name: template.name,
        cron_expression: template.cron_expression,
        prompt: template.prompt,
      }));
    }
    setDialogOpen(true);
  }

  function openEdit(schedule: Schedule) {
    setEditingId(schedule.id);
    setForm({
      name: schedule.name,
      cron_expression: schedule.cron_expression,
      agent_id: schedule.agent_id,
      prompt: schedule.prompt,
      notification_channels: schedule.notification_channels,
      enabled: schedule.enabled,
    });
    setDialogOpen(true);
  }

  function handleSave() {
    if (editingId) {
      updateMutation.mutate({ id: editingId, data: form });
    } else {
      createMutation.mutate(form);
    }
  }

  function cronToHuman(cron: string): string {
    const parts = cron.split(' ');
    if (parts.length !== 5) return cron;
    const [min, hour, , , day] = parts;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let result = '';
    if (min.startsWith('*/')) result = `Every ${min.slice(2)} minutes`;
    else if (hour === '*') result = `Every hour at :${min.padStart(2, '0')}`;
    else if (day === '*') result = `Daily at ${hour}:${min.padStart(2, '0')}`;
    else result = `${days[parseInt(day)] ?? day} at ${hour}:${min.padStart(2, '0')}`;
    return result;
  }

  return (
    <div className="flex flex-col h-full overflow-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Schedules</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Automated agent tasks on a cron schedule
          </p>
        </div>
        <Button onClick={() => openCreate()}>
          <Plus className="h-4 w-4 mr-2" />
          Create Schedule
        </Button>
      </div>

      {/* Templates */}
      {templates.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-muted-foreground mb-3">
            Quick start from template
          </h2>
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <Button
                key={t.name}
                variant="outline"
                size="sm"
                onClick={() => openCreate(t)}
              >
                <Zap className="h-3 w-3 mr-1.5" />
                {t.name}
              </Button>
            ))}
          </div>
          <Separator className="mt-4" />
        </div>
      )}

      {/* Schedules list */}
      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading...</p>
      ) : schedules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Clock className="h-12 w-12 mb-4 opacity-30" />
          <p className="text-lg font-medium">No schedules yet</p>
          <p className="text-sm mt-1">Create one from a template or start from scratch</p>
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map((s) => (
            <Card key={s.id}>
              <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-base">{s.name}</CardTitle>
                    <Badge variant={s.enabled ? 'default' : 'secondary'}>
                      {s.enabled ? 'Active' : 'Disabled'}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {cronToHuman(s.cron_expression)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => runMutation.mutate(s.id)}
                      disabled={runMutation.isPending}
                      title="Run Now"
                    >
                      <Play className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() =>
                        toggleMutation.mutate({
                          id: s.id,
                          enabled: s.enabled ? 0 : 1,
                        })
                      }
                      title={s.enabled ? 'Disable' : 'Enable'}
                    >
                      {s.enabled ? (
                        <Pause className="h-3.5 w-3.5" />
                      ) : (
                        <RotateCw className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEdit(s)}
                      title="Edit"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      onClick={() => {
                        if (confirm(`Delete "${s.name}"?`)) {
                          deleteMutation.mutate(s.id);
                        }
                      }}
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() =>
                        setExpandedId(expandedId === s.id ? null : s.id)
                      }
                    >
                      {expandedId === s.id ? (
                        <ChevronUp className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
                {s.last_run_at && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Last run: {new Date(s.last_run_at).toLocaleString()}
                  </p>
                )}
              </CardHeader>
              {expandedId === s.id && (
                <CardContent className="pt-0 px-4 pb-4">
                  <Separator className="mb-3" />
                  <div className="space-y-2">
                    <div>
                      <span className="text-xs font-medium text-muted-foreground">
                        Cron Expression
                      </span>
                      <p className="text-sm font-mono">{s.cron_expression}</p>
                    </div>
                    <div>
                      <span className="text-xs font-medium text-muted-foreground">
                        Prompt
                      </span>
                      <p className="text-sm whitespace-pre-wrap">{s.prompt}</p>
                    </div>
                    <div>
                      <span className="text-xs font-medium text-muted-foreground">
                        Agent
                      </span>
                      <p className="text-sm">{s.agent_id}</p>
                    </div>
                    {s.last_result && (
                      <div>
                        <span className="text-xs font-medium text-muted-foreground">
                          Last Result
                        </span>
                        <p className="text-sm whitespace-pre-wrap bg-muted p-2 rounded mt-1 max-h-40 overflow-auto">
                          {s.last_result}
                        </p>
                      </div>
                    )}
                  </div>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId ? 'Edit Schedule' : 'Create Schedule'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-sm font-medium">Name</label>
              <Input
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="Morning Briefing"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Cron Expression</label>
              <Input
                value={form.cron_expression}
                onChange={(e) =>
                  setForm((f) => ({ ...f, cron_expression: e.target.value }))
                }
                placeholder="0 8 * * *"
                className="font-mono"
              />
              {form.cron_expression && (
                <p className="text-xs text-muted-foreground mt-1">
                  {cronToHuman(form.cron_expression)}
                </p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium">Agent</label>
              <select
                value={form.agent_id}
                onChange={(e) =>
                  setForm((f) => ({ ...f, agent_id: e.target.value }))
                }
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Prompt</label>
              <Textarea
                value={form.prompt}
                onChange={(e) =>
                  setForm((f) => ({ ...f, prompt: e.target.value }))
                }
                placeholder="What should the agent do?"
                rows={5}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setDialogOpen(false);
                  resetForm();
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={
                  !form.name ||
                  !form.cron_expression ||
                  !form.prompt ||
                  createMutation.isPending ||
                  updateMutation.isPending
                }
              >
                {editingId ? 'Save' : 'Create'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
