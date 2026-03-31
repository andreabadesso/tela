import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bot, ArrowLeft, Save, Link2, BookOpen, Check, Settings2, Sparkles, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { api, type Connection, type KnowledgeSource } from '@/lib/api';
import { cn } from '@/lib/utils';

interface AgentRow {
  id: string;
  name: string;
  model: string;
  system_prompt: string;
  mcp_servers: string;
  knowledge_sources: string;
  permissions: string;
  max_turns: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const MODELS = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', desc: 'Fast, balanced' },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', desc: 'Most capable' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', desc: 'Fastest, cheapest' },
];

export function AgentEdit({ agentId, isNew }: { agentId?: string; isNew?: boolean }) {
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  const [name, setName] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [maxTurns, setMaxTurns] = useState(15);
  const [enabled, setEnabled] = useState(true);
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [knowledgeSources, setKnowledgeSrcs] = useState<string[]>([]);

  const { data: agent } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => api.getAgent(agentId!) as Promise<AgentRow>,
    enabled: !!agentId && !isNew,
  });

  const { data: connections = [] } = useQuery({
    queryKey: ['connections-available'],
    queryFn: () => api.getAvailableConnections(),
  });

  const { data: sources = [] } = useQuery({
    queryKey: ['knowledge-sources'],
    queryFn: () => api.getKnowledgeSources(),
  });

  // Load agent data into form
  useEffect(() => {
    if (agent) {
      setName(agent.name);
      setModel(agent.model);
      setSystemPrompt(agent.system_prompt);
      setMaxTurns(agent.max_turns);
      setEnabled(agent.enabled === 1);
      try { setMcpServers(JSON.parse(agent.mcp_servers)); } catch { setMcpServers([]); }
      try { setKnowledgeSrcs(JSON.parse(agent.knowledge_sources)); } catch { setKnowledgeSrcs([]); }
    }
  }, [agent]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const data = {
        name,
        model,
        system_prompt: systemPrompt,
        max_turns: maxTurns,
        enabled: enabled ? 1 : 0,
        mcp_servers: JSON.stringify(mcpServers),
        knowledge_sources: JSON.stringify(knowledgeSources),
      };
      if (agentId && !isNew) {
        return api.updateAgent(agentId, data);
      }
      return api.createAgent(data);
    },
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agents-full'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      if (isNew && result?.id) {
        window.location.hash = `#/agents/${result.id}`;
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteAgent(agentId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      window.location.hash = '#/agents';
    },
  });

  function toggleMcp(id: string) {
    setMcpServers((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function toggleKnowledge(id: string) {
    setKnowledgeSrcs((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex h-12 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => { window.location.hash = '#/agents'; }}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">
              {isNew ? 'New Agent' : name || 'Agent'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="text-xs text-emerald-400 flex items-center gap-1">
              <Check className="h-3 w-3" /> Saved
            </span>
          )}
          {!isNew && agentId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3 w-3 mr-1.5" />
              Delete
            </Button>
          )}
          <Button
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !name.trim()}
          >
            <Save className="h-3 w-3" />
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6 space-y-6">

          {/* Identity */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4" />
                Identity
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2 space-y-1.5">
                  <Label className="text-xs">Name</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. CTO Agent"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Model</Label>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MODELS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          <div>
                            <span>{m.label}</span>
                            <span className="text-muted-foreground ml-2 text-[10px]">{m.desc}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">System Prompt</Label>
                <Textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Describe the agent's role, personality, and how it should behave..."
                  className="min-h-[160px] resize-y text-sm leading-relaxed"
                />
                <p className="text-[10px] text-muted-foreground">
                  Supports variables: {'{{agent_name}}'}, {'{{company_name}}'}, {'{{today}}'}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* MCP Connections */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Link2 className="h-4 w-4" />
                  MCP Connections
                </CardTitle>
                <Badge variant="outline" className="text-[10px]">
                  {mcpServers.length} of {connections.length} selected
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Select which tool integrations this agent can access. Only connections you have permission to use are shown.
              </p>
            </CardHeader>
            <CardContent>
              {connections.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center">
                  <Link2 className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground">No connections available.</p>
                  <Button
                    variant="link"
                    size="sm"
                    className="text-xs mt-1 h-auto p-0"
                    onClick={() => { window.location.hash = '#/connections'; }}
                  >
                    Go to Connections to set up integrations
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {connections.map((conn) => {
                    const selected = mcpServers.includes(conn.id);
                    const connected = conn.status === 'connected';
                    return (
                      <button
                        key={conn.id}
                        type="button"
                        onClick={() => toggleMcp(conn.id)}
                        className={cn(
                          'flex items-center gap-3 rounded-lg border p-3 text-left transition-all',
                          selected
                            ? 'bg-primary/5 border-primary/30 shadow-sm'
                            : 'border-border hover:border-muted-foreground/20',
                        )}
                      >
                        <div className={cn(
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors',
                          selected
                            ? 'bg-primary border-primary text-primary-foreground'
                            : 'border-muted-foreground/20',
                        )}>
                          {selected && <Check className="h-3 w-3" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium truncate">{conn.name}</p>
                            {connected ? (
                              <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                            ) : (
                              <div className="h-1.5 w-1.5 rounded-full bg-zinc-500 shrink-0" />
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            {conn.type}
                            {conn.token_strategy !== 'company' && (
                              <> · {conn.token_strategy} token</>
                            )}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Knowledge Sources */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <BookOpen className="h-4 w-4" />
                  Knowledge Sources
                </CardTitle>
                <Badge variant="outline" className="text-[10px]">
                  {knowledgeSources.length} of {sources.length} selected
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Select which knowledge bases this agent can search and reference.
              </p>
            </CardHeader>
            <CardContent>
              {sources.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center">
                  <BookOpen className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground">No knowledge sources configured.</p>
                  <Button
                    variant="link"
                    size="sm"
                    className="text-xs mt-1 h-auto p-0"
                    onClick={() => { window.location.hash = '#/knowledge'; }}
                  >
                    Go to Knowledge to add sources
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {sources.map((source) => {
                    const selected = knowledgeSources.includes(source.id);
                    return (
                      <button
                        key={source.id}
                        type="button"
                        onClick={() => toggleKnowledge(source.id)}
                        className={cn(
                          'flex items-center gap-3 rounded-lg border p-3 text-left transition-all',
                          selected
                            ? 'bg-primary/5 border-primary/30 shadow-sm'
                            : 'border-border hover:border-muted-foreground/20',
                        )}
                      >
                        <div className={cn(
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors',
                          selected
                            ? 'bg-primary border-primary text-primary-foreground'
                            : 'border-muted-foreground/20',
                        )}>
                          {selected && <Check className="h-3 w-3" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{source.name}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {source.type} · {source.doc_count} docs
                            {source.status === 'connected' && (
                              <span className="text-emerald-400 ml-1">synced</span>
                            )}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Settings */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Settings2 className="h-4 w-4" />
                Settings
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-1.5">
                  <Label className="text-xs">Max Turns</Label>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={maxTurns}
                    onChange={(e) => setMaxTurns(parseInt(e.target.value, 10) || 15)}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Maximum agent ↔ tool call cycles per message
                  </p>
                </div>
                <div className="space-y-3">
                  <Label className="text-xs">Status</Label>
                  <div className="flex items-center gap-3">
                    <Switch checked={enabled} onCheckedChange={setEnabled} />
                    <span className="text-sm">
                      {enabled ? (
                        <span className="text-emerald-400">Enabled</span>
                      ) : (
                        <span className="text-muted-foreground">Disabled</span>
                      )}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Disabled agents can't be used in chat
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Metadata */}
          {agent && !isNew && (
            <div className="text-[10px] text-muted-foreground flex gap-4">
              <span>ID: {agent.id}</span>
              <span>Created: {new Date(agent.created_at).toLocaleDateString()}</span>
              <span>Updated: {new Date(agent.updated_at).toLocaleDateString()}</span>
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Agent</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{name}"? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
