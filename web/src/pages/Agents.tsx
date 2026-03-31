import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bot, Plus, Pencil, Trash2, Copy, Sparkles, Link2, Power, PowerOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { api, type Connection } from '@/lib/api';
import { useState } from 'react';

interface AgentRow {
  id: string;
  name: string;
  model: string;
  system_prompt: string;
  mcp_servers: string;
  knowledge_sources: string;
  max_turns: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const MODELS: Record<string, string> = {
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-haiku-4-5': 'Haiku 4.5',
};

const TEMPLATES = [
  { label: 'CTO Agent', icon: Sparkles },
  { label: 'CEO Agent', icon: Sparkles },
  { label: 'CFO Agent', icon: Sparkles },
  { label: 'Support Agent', icon: Sparkles },
];

export function Agents() {
  const queryClient = useQueryClient();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteName, setDeleteName] = useState('');

  const { data: agents = [], isLoading } = useQuery({
    queryKey: ['agents-full'],
    queryFn: () => api.getAgents() as Promise<AgentRow[]>,
  });

  const { data: connections = [] } = useQuery({
    queryKey: ['connections-available'],
    queryFn: () => api.getAvailableConnections(),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateAgent(id, { enabled: enabled ? 1 : 0 }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents-full'] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteAgent(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents-full'] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setDeleteId(null);
    },
  });

  function navigate(hash: string) {
    window.location.hash = hash;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex h-12 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Agents</span>
          <Badge variant="secondary" className="text-[10px]">{agents.length}</Badge>
        </div>
        <Button
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => navigate('#/agents/new')}
        >
          <Plus className="h-3 w-3" />
          Create Agent
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Templates */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Quick templates</p>
          <div className="flex flex-wrap gap-2">
            {TEMPLATES.map((t) => (
              <Button
                key={t.label}
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => navigate('#/agents/new')}
              >
                <t.icon className="h-3 w-3" />
                {t.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Agent list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <p className="text-sm">Loading agents...</p>
          </div>
        ) : agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Bot className="h-12 w-12 mb-4 opacity-20" />
            <p className="text-sm font-medium">No agents yet</p>
            <p className="text-xs mt-1">Create your first agent to get started</p>
          </div>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => {
              const isEnabled = agent.enabled === 1;
              let mcpIds: string[] = [];
              try { mcpIds = JSON.parse(agent.mcp_servers); } catch { /* empty */ }
              const mcpNames = mcpIds
                .map((id) => connections.find((c) => c.id === id)?.name)
                .filter(Boolean);

              return (
                <Card
                  key={agent.id}
                  className="p-4 cursor-pointer hover:bg-accent/5 transition-colors"
                  onClick={() => navigate(`#/agents/${agent.id}`)}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium truncate">{agent.name}</span>
                        <Badge
                          variant={isEnabled ? 'default' : 'secondary'}
                          className="text-[10px] shrink-0"
                        >
                          {isEnabled ? 'Active' : 'Disabled'}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{MODELS[agent.model] ?? agent.model}</span>
                        <span>Max {agent.max_turns} turns</span>
                      </div>
                      {agent.system_prompt && (
                        <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
                          {agent.system_prompt}
                        </p>
                      )}
                      {mcpNames.length > 0 && (
                        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                          <Link2 className="h-3 w-3 text-muted-foreground shrink-0" />
                          {mcpNames.map((name) => (
                            <Badge key={name} variant="outline" className="text-[10px]">
                              {name}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={isEnabled}
                        onCheckedChange={(checked) =>
                          toggleMutation.mutate({ id: agent.id, enabled: checked })
                        }
                        className="mr-1"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={(e) => { e.stopPropagation(); navigate(`#/agents/${agent.id}`); }}
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteId(agent.id);
                          setDeleteName(agent.name);
                        }}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <Dialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Agent</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteName}"? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
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
