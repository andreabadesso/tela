import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Radio,
  MessageSquare,
  GitFork,
  TicketCheck,
  Plus,
  Play,
  Square,
  Zap,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Plug,
  Pencil,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, type CommunicationChannel } from '@/lib/api';

// ─── Platform definitions ──────────────────────────────────────

interface PlatformDef {
  id: string;
  name: string;
  icon: React.ReactNode;
  description: string;
  configFields: { key: string; label: string; type: 'text' | 'password'; placeholder: string; required?: boolean }[];
}

const PLATFORMS: PlatformDef[] = [
  {
    id: 'telegram',
    name: 'Telegram',
    icon: <MessageSquare className="h-5 w-5" />,
    description: 'Telegram bot for bidirectional messaging',
    configFields: [
      { key: 'bot_token', label: 'Bot Token', type: 'password', placeholder: 'From @BotFather', required: true },
      { key: 'chat_id', label: 'Chat ID', type: 'text', placeholder: 'Optional — restrict to one chat' },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    icon: <Plug className="h-5 w-5" />,
    description: 'Slack bot with thread context',
    configFields: [
      { key: 'bot_token', label: 'Bot Token (xoxb-...)', type: 'password', placeholder: 'xoxb-...', required: true },
      { key: 'app_token', label: 'App Token (xapp-...)', type: 'password', placeholder: 'xapp-... (for Socket Mode)' },
      { key: 'signing_secret', label: 'Signing Secret', type: 'password', placeholder: 'Signing secret' },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: <GitFork className="h-5 w-5" />,
    description: 'Respond to @mentions on issues & PRs',
    configFields: [
      { key: 'personal_access_token', label: 'Access Token', type: 'password', placeholder: 'ghp_...', required: true },
      { key: 'bot_username', label: 'Bot Username', type: 'text', placeholder: 'e.g. tela-bot', required: true },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password', placeholder: 'For verifying webhook payloads' },
    ],
  },
  {
    id: 'jira',
    name: 'Jira',
    icon: <TicketCheck className="h-5 w-5" />,
    description: 'Monitor and respond to Jira comments',
    configFields: [
      { key: 'base_url', label: 'Jira Base URL', type: 'text', placeholder: 'https://org.atlassian.net', required: true },
      { key: 'user_email', label: 'User Email', type: 'text', placeholder: 'user@company.com', required: true },
      { key: 'api_token', label: 'API Token', type: 'password', placeholder: 'Jira API token', required: true },
      { key: 'bot_mention_name', label: 'Bot @mention Name', type: 'text', placeholder: 'e.g. tela-bot', required: true },
    ],
  },
];

// ─── Status components ─────────────────────────────────────────

function StatusBadge({ status, isRunning }: { status: string; isRunning: boolean }) {
  if (isRunning) {
    return (
      <Badge variant="default" className="bg-emerald-600 hover:bg-emerald-600 gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Running
      </Badge>
    );
  }
  if (status === 'error') {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" />
        Error
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <AlertCircle className="h-3 w-3" />
      Stopped
    </Badge>
  );
}

function DirectionBadge({ direction }: { direction: string }) {
  const icon = direction === 'inbound' ? <ArrowDown className="h-3 w-3" />
    : direction === 'outbound' ? <ArrowUp className="h-3 w-3" />
    : <ArrowUpDown className="h-3 w-3" />;
  return (
    <Badge variant="outline" className="gap-1 text-xs font-normal">
      {icon}
      {direction}
    </Badge>
  );
}

// ─── Channel Card ──────────────────────────────────────────────

function ChannelCard({
  channel,
  agents,
  onStart,
  onStop,
  onTest,
  onEdit,
  onDelete,
  testing,
  starting,
  stopping,
}: {
  channel: CommunicationChannel;
  agents: Array<{ id: string; name: string }>;
  onStart: () => void;
  onStop: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  testing: boolean;
  starting: boolean;
  stopping: boolean;
}) {
  const platform = PLATFORMS.find((p) => p.id === channel.platform);
  const agentName = channel.agent_id
    ? agents.find((a) => a.id === channel.agent_id)?.name ?? channel.agent_id
    : null;

  return (
    <Card className="relative overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              {platform?.icon ?? <Radio className="h-5 w-5" />}
            </div>
            <div>
              <h3 className="text-sm font-semibold">{channel.name}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {platform?.name ?? channel.platform}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DirectionBadge direction={channel.direction} />
            <StatusBadge status={channel.status} isRunning={channel.is_running} />
          </div>
        </div>

        {channel.error_message && (
          <p className="mt-3 text-xs text-destructive bg-destructive/10 rounded px-2 py-1">
            {channel.error_message}
          </p>
        )}

        <p className="mt-2 text-xs text-muted-foreground">
          Agent: <span className="text-foreground">{agentName ?? 'Auto-route (by @mention)'}</span>
        </p>

        <div className="mt-4 flex items-center gap-2">
          {channel.is_running ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onStop}
              disabled={stopping}
              className="gap-1.5"
            >
              {stopping ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
              Stop
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={onStart}
              disabled={starting || !channel.enabled}
              className="gap-1.5"
            >
              {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Start
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onTest}
            disabled={testing}
            className="gap-1.5"
          >
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
            Test
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onEdit}
            className="gap-1.5"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onDelete}
            className="gap-1.5 text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Edit Form ─────────────────────────────────────────────────

function EditChannelForm({
  channel,
  agents,
  onSave,
  onCancel,
  saving,
}: {
  channel: CommunicationChannel;
  agents: Array<{ id: string; name: string }>;
  onSave: (data: Partial<CommunicationChannel>) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(channel.name);
  const [agentId, setAgentId] = useState(channel.agent_id ?? '');
  const [dir, setDir] = useState(channel.direction);

  return (
    <>
      <div className="space-y-4 py-2">
        <div className="space-y-2">
          <Label htmlFor="edit-name">Channel Name</Label>
          <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Direction</Label>
            <Select value={dir} onValueChange={(v) => { if (v) setDir(v); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="bidirectional">Bidirectional</SelectItem>
                <SelectItem value="inbound">Inbound only</SelectItem>
                <SelectItem value="outbound">Outbound only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Default Agent</Label>
            <Select value={agentId} onValueChange={(v) => setAgentId(v ?? '')}>
              <SelectTrigger><SelectValue placeholder="Auto-route" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">Auto-route (by @mention)</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button
          onClick={() => onSave({ name: name.trim(), agent_id: agentId || null, direction: dir })}
          disabled={!name.trim() || saving}
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
          Save Changes
        </Button>
      </DialogFooter>
    </>
  );
}

// ─── Main Page ─────────────────────────────────────────────────

export function Channels() {
  const queryClient = useQueryClient();
  const [createDialog, setCreateDialog] = useState(false);
  const [editDialog, setEditDialog] = useState<CommunicationChannel | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<CommunicationChannel | null>(null);
  const [selectedPlatform, setSelectedPlatform] = useState<string>('telegram');
  const [channelName, setChannelName] = useState('');
  const [direction, setDirection] = useState<string>('bidirectional');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean } | null>(null);

  // Fetch agents for the agent selector
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.getAgents(),
  });
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');

  const { data: channels = [], isLoading } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.getChannels(),
    refetchInterval: 10000,
  });

  const createMutation = useMutation({
    mutationFn: (data: Partial<CommunicationChannel>) => api.createChannel(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      resetCreateForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CommunicationChannel> }) => api.updateChannel(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      setEditDialog(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteChannel(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      setDeleteDialog(null);
    },
  });

  const resetCreateForm = () => {
    setCreateDialog(false);
    setChannelName('');
    setSelectedPlatform('telegram');
    setDirection('bidirectional');
    setConfigValues({});
    setSelectedAgentId('');
  };

  const handleCreate = () => {
    const platform = PLATFORMS.find((p) => p.id === selectedPlatform);
    if (!platform || !channelName.trim()) return;

    createMutation.mutate({
      name: channelName.trim(),
      platform: selectedPlatform,
      direction,
      agent_id: selectedAgentId || null,
      config: configValues as any,
      enabled: 1,
    });
  };

  const handleStart = async (id: string) => {
    setStartingId(id);
    try {
      await api.startChannel(id);
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    } catch (err) {
      console.error('Failed to start channel:', err);
    } finally {
      setStartingId(null);
    }
  };

  const handleStop = async (id: string) => {
    setStoppingId(id);
    try {
      await api.stopChannel(id);
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    } catch (err) {
      console.error('Failed to stop channel:', err);
    } finally {
      setStoppingId(null);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const result = await api.testChannel(id);
      setTestResult({ id, ok: result.success });
    } catch {
      setTestResult({ id, ok: false });
    } finally {
      setTestingId(null);
    }
  };

  const currentPlatform = PLATFORMS.find((p) => p.id === selectedPlatform);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Communication Channels</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {channels.filter((c) => c.is_running).length} running
          </span>
          <Button size="sm" onClick={() => setCreateDialog(true)} className="gap-1.5">
            <Plus className="h-3 w-3" />
            Add Channel
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : channels.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Radio className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <h3 className="text-sm font-medium">No channels configured</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Add a channel to connect agents to Telegram, Slack, GitHub, or Jira.
            </p>
            <Button size="sm" className="mt-4 gap-1.5" onClick={() => setCreateDialog(true)}>
              <Plus className="h-3 w-3" />
              Add Channel
            </Button>
          </div>
        ) : (
          <>
            {/* Test result toast */}
            {testResult && (
              <div
                className={`mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                  testResult.ok
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-destructive/30 bg-destructive/10 text-destructive'
                }`}
              >
                {testResult.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                <span>{testResult.ok ? 'Connection successful' : 'Connection failed'}</span>
                <button onClick={() => setTestResult(null)} className="ml-auto text-muted-foreground hover:text-foreground">
                  &times;
                </button>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {channels.map((channel) => (
                <ChannelCard
                  key={channel.id}
                  channel={channel}
                  agents={agents}
                  onStart={() => handleStart(channel.id)}
                  onStop={() => handleStop(channel.id)}
                  onTest={() => handleTest(channel.id)}
                  onEdit={() => setEditDialog(channel)}
                  onDelete={() => setDeleteDialog(channel)}
                  testing={testingId === channel.id}
                  starting={startingId === channel.id}
                  stopping={stoppingId === channel.id}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Create Channel Dialog */}
      <Dialog open={createDialog} onOpenChange={(open) => !open && resetCreateForm()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Communication Channel</DialogTitle>
            <DialogDescription>
              Connect an agent to a messaging platform.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Platform</Label>
              <Select value={selectedPlatform} onValueChange={(v) => { if (v) { setSelectedPlatform(v); setConfigValues({}); } }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <div className="flex items-center gap-2">
                        {p.icon}
                        <span>{p.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {currentPlatform && (
                <p className="text-xs text-muted-foreground">{currentPlatform.description}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="channel-name">Channel Name</Label>
              <Input
                id="channel-name"
                placeholder={`My ${currentPlatform?.name ?? ''} Bot`}
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Direction</Label>
                <Select value={direction} onValueChange={(v) => { if (v) setDirection(v); }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bidirectional">Bidirectional</SelectItem>
                    <SelectItem value="inbound">Inbound only</SelectItem>
                    <SelectItem value="outbound">Outbound only</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Default Agent</Label>
                <Select value={selectedAgentId} onValueChange={(v) => setSelectedAgentId(v ?? '')}>
                  <SelectTrigger>
                    <SelectValue placeholder="Auto-route" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Auto-route (by @mention)</SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {currentPlatform?.configFields.map((field) => (
              <div key={field.key} className="space-y-2">
                <Label htmlFor={field.key}>
                  {field.label}
                  {field.required && <span className="text-destructive ml-1">*</span>}
                </Label>
                <Input
                  id={field.key}
                  type={field.type}
                  placeholder={field.placeholder}
                  value={configValues[field.key] ?? ''}
                  onChange={(e) => setConfigValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={resetCreateForm}>Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={!channelName.trim() || createMutation.isPending}
            >
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Create Channel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Channel Dialog */}
      <Dialog open={!!editDialog} onOpenChange={(open) => !open && setEditDialog(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit {editDialog?.name}</DialogTitle>
            <DialogDescription>
              Update channel settings. Changes take effect after restarting the channel.
            </DialogDescription>
          </DialogHeader>
          {editDialog && (
            <EditChannelForm
              channel={editDialog}
              agents={agents}
              onSave={(data) => updateMutation.mutate({ id: editDialog.id, data })}
              onCancel={() => setEditDialog(null)}
              saving={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteDialog} onOpenChange={(open) => !open && setDeleteDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteDialog?.name}?</DialogTitle>
            <DialogDescription>
              This will stop the channel and remove it permanently. Thread history will be preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialog(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteDialog && deleteMutation.mutate(deleteDialog.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
