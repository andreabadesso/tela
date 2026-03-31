import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Folder,
  RefreshCw,
  Plus,
  Loader2,
  Clock,
  FileText,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api, type KnowledgeSource } from '@/lib/api';

const typeIcons: Record<string, React.ReactNode> = {
  obsidian: <BookOpen className="h-5 w-5" />,
  filesystem: <Folder className="h-5 w-5" />,
};

const typeLabels: Record<string, string> = {
  obsidian: 'Obsidian Vault',
  filesystem: 'Filesystem',
};

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function StatusDot({ source }: { source: KnowledgeSource }) {
  const hasError = source.liveError || source.error_message;
  const isIndexing = source.status === 'indexing' || source.status === 'syncing';
  if (hasError) return <div className="h-2 w-2 rounded-full bg-red-500 shrink-0" title="Error" />;
  if (isIndexing) return <div className="h-2 w-2 rounded-full bg-yellow-500 animate-pulse shrink-0" title="Indexing" />;
  if (source.connected) return <div className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" title="Synced" />;
  return <div className="h-2 w-2 rounded-full bg-zinc-500 shrink-0" title="Disconnected" />;
}

export function Knowledge() {
  const queryClient = useQueryClient();
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());

  const { data: sources, isLoading } = useQuery({
    queryKey: ['knowledge-sources'],
    queryFn: () => api.getKnowledgeSources(),
  });

  const syncMutation = useMutation({
    mutationFn: (id: string) => api.syncKnowledgeSource(id),
    onMutate: (id) => {
      setSyncingIds((prev) => new Set(prev).add(id));
    },
    onSettled: (_data, _err, id) => {
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ['knowledge-sources'] });
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
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Knowledge Sources</span>
          {sources && sources.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">{sources.length}</Badge>
          )}
        </div>
        <Button
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => navigate('#/knowledge/add')}
        >
          <Plus className="h-3 w-3" />
          Add Knowledge Source
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !sources || sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <BookOpen className="mb-3 h-12 w-12 text-muted-foreground/20" />
            <p className="text-sm font-medium text-muted-foreground">No knowledge sources</p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              Add an Obsidian vault or folder to get started.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4 gap-1.5 text-xs"
              onClick={() => navigate('#/knowledge/add')}
            >
              <Plus className="h-3 w-3" />
              Add Knowledge Source
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sources.map((source) => {
              const config = JSON.parse(source.config || '{}') as { path?: string; rootScope?: string };
              const isSyncing = syncingIds.has(source.id);

              return (
                <Card
                  key={source.id}
                  className="group cursor-pointer p-4 transition-all hover:bg-accent/5 hover:shadow-sm"
                  onClick={() => navigate(`#/knowledge/${source.id}`)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                        {typeIcons[source.type] ?? <Folder className="h-5 w-5" />}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{source.name}</p>
                          <StatusDot source={source} />
                        </div>
                        <Badge variant="outline" className="text-[10px] mt-0.5">
                          {typeLabels[source.type] ?? source.type}
                        </Badge>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        syncMutation.mutate(source.id);
                      }}
                      disabled={isSyncing}
                      title="Sync now"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                    </Button>
                  </div>

                  <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <FileText className="h-3 w-3" />
                      <span>{source.liveDocCount ?? source.doc_count} docs</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      <span>{formatRelativeTime(source.last_sync_at)}</span>
                    </div>
                  </div>

                  {(source.liveError || source.error_message) && (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-red-400">
                      <AlertCircle className="h-3 w-3" />
                      <span className="truncate">{source.liveError || source.error_message}</span>
                    </div>
                  )}

                  {config.rootScope && (
                    <p className="mt-2 text-[10px] text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity truncate">
                      Scoped to {config.rootScope}
                    </p>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
