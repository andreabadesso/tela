import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Folder,
  ArrowLeft,
  RefreshCw,
  Trash2,
  Check,
  FileText,
  Tag,
  ChevronRight,
  ChevronDown,
  Loader2,
  AlertCircle,
  FolderTree,
  Plus,
  Database,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  api,
  type KnowledgeSource,
  type FolderNode,
  type KnowledgeFile,
} from '@/lib/api';
import { cn } from '@/lib/utils';

// ─── Helpers ────────────────────────────────────────────────

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

function countAllFolders(nodes: FolderNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1 + countAllFolders(node.children);
  }
  return count;
}

function StatusBadge({ source }: { source: KnowledgeSource }) {
  const hasError = source.liveError || source.error_message;
  const isIndexing = source.status === 'indexing' || source.status === 'syncing';
  if (hasError) {
    return (
      <Badge variant="destructive" className="text-[10px] gap-1">
        <AlertCircle className="h-2.5 w-2.5" />
        Error
      </Badge>
    );
  }
  if (isIndexing) {
    return (
      <Badge className="text-[10px] gap-1 bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Indexing
      </Badge>
    );
  }
  if (source.connected) {
    return (
      <Badge className="text-[10px] gap-1 bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
        <Check className="h-2.5 w-2.5" />
        Synced
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-[10px]">Disconnected</Badge>
  );
}

// ─── Folder Tree (full-height, deeply nested) ──────────────

function FolderTreePanel({
  nodes,
  selectedFolder,
  onSelectFolder,
}: {
  nodes: FolderNode[];
  selectedFolder: string | null;
  onSelectFolder: (path: string | null) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  function handleClick(node: FolderNode) {
    // Always expand on click (toggle if already expanded and re-clicking same)
    if (node.children.length > 0) {
      if (!expanded.has(node.path)) {
        setExpanded((prev) => new Set(prev).add(node.path));
      } else if (selectedFolder === node.path) {
        // Clicking again on same selected folder -> collapse
        toggleExpand(node.path);
      }
    }
    onSelectFolder(selectedFolder === node.path ? null : node.path);
  }

  function renderNode(node: FolderNode, depth: number) {
    const isExpanded = expanded.has(node.path);
    const isSelected = selectedFolder === node.path;
    const hasChildren = node.children.length > 0;

    return (
      <div key={node.path}>
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/50',
            isSelected && 'bg-primary/10 text-primary font-medium'
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => handleClick(node)}
        >
          {hasChildren ? (
            isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <Folder className={cn('h-3.5 w-3.5 shrink-0', isSelected ? 'text-primary' : 'text-muted-foreground')} />
          <span className="truncate">{node.name}</span>
          <Badge variant="outline" className="text-[9px] ml-auto shrink-0 tabular-nums">
            {node.fileCount}
          </Badge>
        </button>
        {hasChildren && isExpanded && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {/* Root "All folders" option */}
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/50',
          selectedFolder === null && 'bg-primary/10 text-primary font-medium'
        )}
        onClick={() => onSelectFolder(null)}
      >
        <FolderTree className={cn('h-3.5 w-3.5', selectedFolder === null ? 'text-primary' : 'text-muted-foreground')} />
        <span>All folders</span>
      </button>
      {nodes.map((node) => renderNode(node, 0))}
    </div>
  );
}

// ─── File Preview (inline) ─────────────────────────────────

function FilePreview({
  sourceId,
  filePath,
  onClose,
}: {
  sourceId: string;
  filePath: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['knowledge-file', sourceId, filePath],
    queryFn: () => api.getKnowledgeFile(sourceId, filePath),
  });

  return (
    <div className="border-t border-border mt-2">
      <div className="flex items-center justify-between px-3 py-2 bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-mono truncate">{filePath.split('/').pop()?.replace(/\.md$/, '')}</span>
          <span className="text-[10px] text-muted-foreground truncate">{filePath}</span>
        </div>
        <Button variant="ghost" size="sm" className="h-6 text-[10px] shrink-0" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="max-h-[300px] overflow-y-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : data ? (
          <div className="space-y-3">
            {data.frontmatter && Object.keys(data.frontmatter).length > 0 && (
              <div className="rounded-lg bg-muted p-3">
                <p className="text-[10px] text-muted-foreground mb-1 font-medium uppercase tracking-wide">Frontmatter</p>
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
                  {JSON.stringify(data.frontmatter, null, 2)}
                </pre>
              </div>
            )}
            <pre className="text-sm leading-relaxed whitespace-pre-wrap font-mono">{data.content}</pre>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Unable to load file content.</p>
        )}
      </div>
    </div>
  );
}

// ─── Right Panel: Overview (no folder selected) ────────────

function OverviewPanel({
  source,
  folders,
  tags,
  selectedTag,
  onSelectTag,
}: {
  source: KnowledgeSource;
  folders: FolderNode[];
  tags: { tag: string; count: number }[];
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
}) {
  const totalFolders = countAllFolders(folders);

  return (
    <div className="p-4 space-y-6">
      {/* Stats */}
      <div>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Overview</h3>
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-border p-3 text-center">
            <p className="text-lg font-semibold tabular-nums">{source.liveDocCount ?? source.doc_count}</p>
            <p className="text-[10px] text-muted-foreground">Files</p>
          </div>
          <div className="rounded-lg border border-border p-3 text-center">
            <p className="text-lg font-semibold tabular-nums">{totalFolders}</p>
            <p className="text-[10px] text-muted-foreground">Folders</p>
          </div>
          <div className="rounded-lg border border-border p-3 text-center">
            <p className="text-lg font-semibold tabular-nums">{tags.length}</p>
            <p className="text-[10px] text-muted-foreground">Tags</p>
          </div>
        </div>
      </div>

      {/* Source info */}
      <div>
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Source</h3>
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Type</span>
            <Badge variant="outline" className="text-[10px]">{source.type}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Last synced</span>
            <span className="text-xs">{formatRelativeTime(source.last_sync_at)}</span>
          </div>
          {(() => {
            const cfg = JSON.parse(source.config || '{}');
            const vp = cfg.vaultPath || cfg.path || '';
            return vp ? (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Vault path</span>
                <span className="text-xs font-mono truncate max-w-[200px]">{vp}</span>
              </div>
            ) : null;
          })()}
        </div>
      </div>

      {/* Tag cloud */}
      {tags.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Tags</h3>
            {selectedTag && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 text-[10px] px-1.5"
                onClick={() => onSelectTag(null)}
              >
                Clear filter
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tags.sort((a, b) => b.count - a.count).map((t) => (
              <button
                key={t.tag}
                type="button"
                onClick={() => onSelectTag(selectedTag === t.tag ? null : t.tag)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                  selectedTag === t.tag
                    ? 'bg-primary/10 border-primary/30 text-primary'
                    : 'border-border text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground'
                )}
              >
                <span>#{t.tag}</span>
                <span className="text-[9px] opacity-60">{t.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Right Panel: Folder selected (file list + preview) ────

function FolderFilesPanel({
  sourceId,
  folderPath,
  files,
  totalFiles,
  isLoading,
  selectedTag,
  onSelectTag,
}: {
  sourceId: string;
  folderPath: string;
  files: KnowledgeFile[];
  totalFiles: number;
  isLoading: boolean;
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
}) {
  const [previewFile, setPreviewFile] = useState<string | null>(null);

  const folderName = folderPath.split('/').pop() || folderPath;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Folder className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-medium">{folderName}</h3>
          <Badge variant="outline" className="text-[10px] tabular-nums">{totalFiles} files</Badge>
          {selectedTag && (
            <Badge className="text-[10px] gap-1 bg-primary/10 text-primary border-primary/30">
              #{selectedTag}
              <button type="button" onClick={() => onSelectTag(null)} className="ml-0.5 hover:text-foreground">
                x
              </button>
            </Badge>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">{folderPath}</p>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : files.length > 0 ? (
          <div className="divide-y divide-border/50">
            {files.map((file) => {
              const isActive = previewFile === file.path;
              return (
                <button
                  key={file.path}
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-accent/30 transition-colors',
                    isActive && 'bg-accent/50'
                  )}
                  onClick={() => setPreviewFile(isActive ? null : file.path)}
                >
                  <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="truncate">{file.name.replace(/\.md$/, '')}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-muted-foreground">{formatRelativeTime(file.lastModified)}</span>
                      {file.folder && file.folder !== folderPath && (
                        <span className="text-[10px] text-muted-foreground/60 truncate">{file.folder}</span>
                      )}
                    </div>
                  </div>
                  {file.tags?.length > 0 && (
                    <div className="flex gap-1 shrink-0">
                      {file.tags.slice(0, 2).map((t) => (
                        <Badge key={t} variant="outline" className="text-[9px]">{t}</Badge>
                      ))}
                      {file.tags.length > 2 && (
                        <span className="text-[9px] text-muted-foreground">+{file.tags.length - 2}</span>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FileText className="h-8 w-8 text-muted-foreground/20 mb-2" />
            <p className="text-xs text-muted-foreground">No files in this folder</p>
          </div>
        )}

        {/* Inline preview */}
        {previewFile && (
          <FilePreview
            sourceId={sourceId}
            filePath={previewFile}
            onClose={() => setPreviewFile(null)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Create Knowledge Base Dialog ──────────────────────────

function CreateKnowledgeBaseDialog({
  open,
  onOpenChange,
  folderPath,
  vaultPath,
  sourceType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderPath: string;
  vaultPath: string;
  sourceType: string;
}) {
  const queryClient = useQueryClient();
  const folderName = folderPath.split('/').pop() || folderPath;
  const [name, setName] = useState(folderName);

  const createMutation = useMutation({
    mutationFn: () =>
      api.createKnowledgeSource({
        name: name.trim(),
        type: sourceType || 'obsidian',
        config: {
          vaultPath: vaultPath,
          rootScope: folderPath,
        },
      }),
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-sources'] });
      const id = result?.id;
      if (id) {
        api.syncKnowledgeSource(id).catch(() => {});
        window.location.hash = `#/knowledge/${id}`;
      }
      onOpenChange(false);
    },
  });

  // Reset name when folder changes
  const handleOpenChange = (v: boolean) => {
    if (v) setName(folderName);
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" />
            Create Knowledge Base
          </DialogTitle>
          <DialogDescription>
            Create a new knowledge source scoped to this folder. It will index only files under this path.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Knowledge base name"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Scope</Label>
            <div className="rounded-lg bg-muted px-3 py-2">
              <p className="text-sm font-mono">{folderPath}</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Vault path</Label>
            <div className="rounded-lg bg-muted px-3 py-2">
              <p className="text-sm font-mono text-muted-foreground">{vaultPath || 'Inherited from parent'}</p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!name.trim() || createMutation.isPending}
          >
            {createMutation.isPending && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Component ─────────────────────────────────────────

export function KnowledgeDetail({ sourceId }: { sourceId: string }) {
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [createKBOpen, setCreateKBOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  // Browse state
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const { data: source, isLoading } = useQuery({
    queryKey: ['knowledge-source', sourceId],
    queryFn: async () => {
      const sources = await api.getKnowledgeSources();
      return sources.find((s) => s.id === sourceId) || null;
    },
  });

  const { data: folders = [] } = useQuery({
    queryKey: ['knowledge-folders', sourceId],
    queryFn: () => api.getKnowledgeFolders(sourceId),
    enabled: !!source,
  });

  const { data: tags = [] } = useQuery({
    queryKey: ['knowledge-tags', sourceId],
    queryFn: () => api.getKnowledgeTags(sourceId),
    enabled: !!source,
  });

  const { data: filesData, isLoading: filesLoading } = useQuery({
    queryKey: ['knowledge-files', sourceId, selectedFolder, selectedTag],
    queryFn: () => api.getKnowledgeFiles(sourceId, {
      folder: selectedFolder ?? undefined,
      tag: selectedTag ?? undefined,
      limit: 100,
    }),
    enabled: !!source,
  });

  const syncMutation = useMutation({
    mutationFn: () => api.syncKnowledgeSource(sourceId),
    onMutate: () => setIsSyncing(true),
    onSettled: () => {
      setIsSyncing(false);
      queryClient.invalidateQueries({ queryKey: ['knowledge-source', sourceId] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-sources'] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-folders', sourceId] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-tags', sourceId] });
      queryClient.invalidateQueries({ queryKey: ['knowledge-files', sourceId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteKnowledgeSource(sourceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-sources'] });
      window.location.hash = '#/knowledge';
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!source) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <AlertCircle className="h-8 w-8 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">Knowledge source not found</p>
        <Button variant="outline" size="sm" onClick={() => { window.location.hash = '#/knowledge'; }}>
          Back to Knowledge
        </Button>
      </div>
    );
  }

  const config = JSON.parse(source.config || '{}') as { path?: string; vaultPath?: string; rootScope?: string };
  const resolvedVaultPath = config.vaultPath || config.path || '';
  const files = filesData?.files ?? [];
  const totalFiles = filesData?.total ?? 0;

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex h-12 items-center justify-between border-b border-border px-4 shrink-0">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => { window.location.hash = '#/knowledge'; }}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{source.name}</span>
          </div>
          <StatusBadge source={source} />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => syncMutation.mutate()}
            disabled={isSyncing}
          >
            <RefreshCw className={cn('h-3 w-3', isSyncing && 'animate-spin')} />
            Sync Now
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-3 w-3 mr-1.5" />
            Delete
          </Button>
        </div>
      </div>

      {/* 2-column layout */}
      <div className="flex flex-1 min-h-0">
        {/* Left panel — Folder tree */}
        <div className="w-[40%] border-r border-border flex flex-col min-h-0">
          <div className="px-3 py-2.5 border-b border-border shrink-0">
            <div className="flex items-center gap-2">
              <FolderTree className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Folders</span>
            </div>
          </div>

          {/* Scrollable tree */}
          <div className="flex-1 overflow-y-auto p-2">
            {folders.length > 0 ? (
              <FolderTreePanel
                nodes={folders}
                selectedFolder={selectedFolder}
                onSelectFolder={setSelectedFolder}
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Folder className="h-8 w-8 text-muted-foreground/20 mb-2" />
                <p className="text-xs text-muted-foreground">No folder data yet</p>
                <p className="text-[10px] text-muted-foreground/60 mt-1">Sync the source to discover folders</p>
              </div>
            )}
          </div>

          {/* Floating action bar when a folder is selected */}
          {selectedFolder && (
            <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-3">
              <div className="flex items-center gap-2 mb-2">
                <Folder className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-[11px] text-muted-foreground truncate">{selectedFolder}</span>
              </div>
              <Button
                size="sm"
                className="w-full h-8 text-xs gap-1.5"
                onClick={() => setCreateKBOpen(true)}
              >
                <Plus className="h-3 w-3" />
                Create Knowledge Base
              </Button>
            </div>
          )}
        </div>

        {/* Right panel — Context-dependent */}
        <div className="w-[60%] flex flex-col min-h-0">
          {selectedFolder ? (
            <FolderFilesPanel
              sourceId={sourceId}
              folderPath={selectedFolder}
              files={files}
              totalFiles={totalFiles}
              isLoading={filesLoading}
              selectedTag={selectedTag}
              onSelectTag={setSelectedTag}
            />
          ) : (
            <div className="flex-1 overflow-y-auto">
              <OverviewPanel
                source={source}
                folders={folders}
                tags={tags}
                selectedTag={selectedTag}
                onSelectTag={(tag) => {
                  setSelectedTag(tag);
                }}
              />

              {/* Files when filtering by tag (no folder selected) */}
              {selectedTag && (
                <div className="px-4 pb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Tag className="h-3.5 w-3.5 text-primary" />
                    <span className="text-xs font-medium">Files tagged #{selectedTag}</span>
                    <Badge variant="outline" className="text-[10px] tabular-nums">{totalFiles}</Badge>
                  </div>
                  {filesLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : files.length > 0 ? (
                    <div className="rounded-lg border border-border divide-y divide-border/50">
                      {files.map((file) => (
                        <div
                          key={file.path}
                          className="flex items-center gap-3 px-3 py-2 text-sm"
                        >
                          <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="truncate">{file.name.replace(/\.md$/, '')}</p>
                            <span className="text-[10px] text-muted-foreground">{file.folder}</span>
                          </div>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {formatRelativeTime(file.lastModified)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground text-center py-4">No files found with this tag</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Create Knowledge Base dialog */}
      {selectedFolder && (
        <CreateKnowledgeBaseDialog
          open={createKBOpen}
          onOpenChange={setCreateKBOpen}
          folderPath={selectedFolder}
          vaultPath={resolvedVaultPath}
          sourceType={source.type}
        />
      )}

      {/* Delete Confirmation */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Knowledge Source</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{source.name}"? This will remove the index and all policies. The original vault files will not be touched.
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
