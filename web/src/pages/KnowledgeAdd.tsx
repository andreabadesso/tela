import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  BookOpen,
  Folder,
  ArrowLeft,
  ArrowRight,
  Search,
  Loader2,
  Check,
  ChevronRight,
  ChevronDown,
  AlertCircle,
  FileText,
  FolderTree,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { api, type VaultScanResult, type FolderNode } from '@/lib/api';
import { cn } from '@/lib/utils';

type SourceType = 'obsidian' | 'filesystem';

interface WizardState {
  step: number;
  sourceType: SourceType | null;
  path: string;
  scanResult: VaultScanResult | null;
  scanError: string | null;
  includeAll: boolean;
  selectedFolders: Set<string>;
  name: string;
  gitRemoteUrl: string;
}

const STEPS = [
  { num: 1, label: 'Source Type' },
  { num: 2, label: 'Location' },
  { num: 3, label: 'Scope' },
  { num: 4, label: 'Configure' },
  { num: 5, label: 'Review' },
];

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex items-center justify-center gap-1 py-4">
      {STEPS.map((step, i) => (
        <div key={step.num} className="flex items-center">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors',
                currentStep > step.num
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : currentStep === step.num
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              {currentStep > step.num ? <Check className="h-3.5 w-3.5" /> : step.num}
            </div>
            <span
              className={cn(
                'text-xs hidden sm:inline',
                currentStep === step.num ? 'text-foreground font-medium' : 'text-muted-foreground'
              )}
            >
              {step.label}
            </span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={cn(
              'mx-3 h-px w-8',
              currentStep > step.num ? 'bg-emerald-500/30' : 'bg-border'
            )} />
          )}
        </div>
      ))}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function FolderTreeView({
  nodes,
  selectedFolders,
  onToggle,
  depth = 0,
}: {
  nodes: FolderNode[];
  selectedFolders: Set<string>;
  onToggle: (path: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        const isExpanded = expanded.has(node.path);
        const isSelected = selectedFolders.has(node.path);
        const hasChildren = node.children.length > 0;

        return (
          <div key={node.path}>
            <div
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/50',
                isSelected && 'bg-primary/5'
              )}
              style={{ paddingLeft: `${depth * 20 + 8}px` }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => toggleExpand(node.path)}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              <button
                type="button"
                onClick={() => onToggle(node.path)}
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                  isSelected
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'border-muted-foreground/30 hover:border-muted-foreground/50'
                )}
              >
                {isSelected && <Check className="h-2.5 w-2.5" />}
              </button>
              <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="truncate">{node.name}</span>
              <Badge variant="outline" className="text-[10px] ml-auto shrink-0">
                {node.fileCount}
              </Badge>
            </div>
            {hasChildren && isExpanded && (
              <FolderTreeView
                nodes={node.children}
                selectedFolders={selectedFolders}
                onToggle={onToggle}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function getAllFolderPaths(nodes: FolderNode[]): string[] {
  const paths: string[] = [];
  function walk(nodes: FolderNode[]) {
    for (const node of nodes) {
      paths.push(node.path);
      walk(node.children);
    }
  }
  walk(nodes);
  return paths;
}

function countSelectedFiles(nodes: FolderNode[], selected: Set<string>): number {
  let total = 0;
  function walk(nodes: FolderNode[]) {
    for (const node of nodes) {
      if (selected.has(node.path)) total += node.fileCount;
      walk(node.children);
    }
  }
  walk(nodes);
  return total;
}

export function KnowledgeAdd() {
  const [state, setState] = useState<WizardState>({
    step: 1,
    sourceType: null,
    path: '',
    scanResult: null,
    scanError: null,
    includeAll: true,
    selectedFolders: new Set(),
    name: '',
    gitRemoteUrl: '',
  });

  const scanMutation = useMutation({
    mutationFn: (path: string) => api.scanVaultPath(path),
    onSuccess: (result) => {
      const allPaths = getAllFolderPaths(result.folders);
      const folderName = state.path.split('/').filter(Boolean).pop() || 'Knowledge';
      setState((prev) => ({
        ...prev,
        scanResult: result,
        scanError: null,
        selectedFolders: new Set(allPaths),
        name: prev.name || folderName,
      }));
    },
    onError: (err: Error) => {
      setState((prev) => ({ ...prev, scanResult: null, scanError: err.message }));
    },
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = { path: state.path };
      if (!state.includeAll && state.selectedFolders.size > 0) {
        config.selectedFolders = Array.from(state.selectedFolders);
      }
      if (state.gitRemoteUrl.trim()) {
        config.gitRemoteUrl = state.gitRemoteUrl.trim();
      }
      return api.createKnowledgeSource({
        name: state.name.trim(),
        type: state.sourceType || 'obsidian',
        config,
      });
    },
    onSuccess: (result: any) => {
      const id = result?.id;
      if (id) {
        // Trigger sync in background
        api.syncKnowledgeSource(id).catch(() => {});
        window.location.hash = `#/knowledge/${id}`;
      } else {
        window.location.hash = '#/knowledge';
      }
    },
  });

  const update = useCallback((partial: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  function goNext() {
    update({ step: state.step + 1 });
  }
  function goBack() {
    if (state.step === 1) {
      window.location.hash = '#/knowledge';
    } else {
      update({ step: state.step - 1 });
    }
  }

  function toggleFolder(path: string) {
    setState((prev) => {
      const next = new Set(prev.selectedFolders);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { ...prev, selectedFolders: next, includeAll: false };
    });
  }

  function selectAll() {
    if (!state.scanResult) return;
    const allPaths = getAllFolderPaths(state.scanResult.folders);
    update({ selectedFolders: new Set(allPaths), includeAll: true });
  }

  function deselectAll() {
    update({ selectedFolders: new Set(), includeAll: false });
  }

  const selectedFileCount = state.scanResult
    ? state.includeAll
      ? state.scanResult.totalFiles
      : countSelectedFiles(state.scanResult.folders, state.selectedFolders)
    : 0;

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex h-12 items-center border-b border-border px-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={goBack}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Add Knowledge Source</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl p-6">
          <StepIndicator currentStep={state.step} />

          {/* Step 1 — Source type */}
          {state.step === 1 && (
            <div className="space-y-4 mt-6">
              <div>
                <h2 className="text-lg font-medium">Choose source type</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  What kind of knowledge source do you want to connect?
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {([
                  {
                    type: 'obsidian' as SourceType,
                    icon: BookOpen,
                    title: 'Obsidian Vault',
                    desc: 'Connect an Obsidian vault with frontmatter, tags, and wikilinks support',
                  },
                  {
                    type: 'filesystem' as SourceType,
                    icon: Folder,
                    title: 'Folder',
                    desc: 'Index markdown and text files from any directory on the filesystem',
                  },
                ]).map((opt) => {
                  const selected = state.sourceType === opt.type;
                  return (
                    <button
                      key={opt.type}
                      type="button"
                      onClick={() => {
                        update({ sourceType: opt.type });
                        goNext();
                      }}
                      className={cn(
                        'flex flex-col items-center gap-3 rounded-xl border-2 p-6 text-center transition-all hover:shadow-sm',
                        selected
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-muted-foreground/30'
                      )}
                    >
                      <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-muted">
                        <opt.icon className="h-7 w-7" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{opt.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{opt.desc}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 2 — Location */}
          {state.step === 2 && (
            <div className="space-y-4 mt-6">
              <div>
                <h2 className="text-lg font-medium">
                  {state.sourceType === 'obsidian' ? 'Vault location' : 'Folder location'}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Enter the absolute path to the {state.sourceType === 'obsidian' ? 'vault' : 'folder'} on the server.
                </p>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">
                  {state.sourceType === 'obsidian' ? 'Vault path' : 'Folder path'}
                </Label>
                <div className="flex gap-2">
                  <Input
                    value={state.path}
                    onChange={(e) => update({ path: e.target.value, scanResult: null, scanError: null })}
                    placeholder="/data/vault"
                    className="flex-1"
                  />
                  <Button
                    onClick={() => scanMutation.mutate(state.path)}
                    disabled={!state.path.trim() || scanMutation.isPending}
                    className="gap-1.5"
                  >
                    {scanMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Search className="h-3.5 w-3.5" />
                    )}
                    Scan
                  </Button>
                </div>
              </div>

              {state.scanError && (
                <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{state.scanError}</span>
                </div>
              )}

              {state.scanResult && (
                <Card className="border-emerald-500/30 bg-emerald-500/5">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/20">
                        <Check className="h-5 w-5 text-emerald-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Scan complete</p>
                        <p className="text-xs text-muted-foreground">
                          Found {state.scanResult.totalFiles} files in {state.scanResult.totalFolders} folders ({formatBytes(state.scanResult.sizeBytes)})
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="flex justify-between pt-4">
                <Button variant="outline" onClick={goBack}>
                  <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
                  Back
                </Button>
                <Button onClick={goNext} disabled={!state.scanResult}>
                  Next
                  <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 3 — Scope */}
          {state.step === 3 && (
            <div className="space-y-4 mt-6">
              <div>
                <h2 className="text-lg font-medium">Select folders to include</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Choose which folders should be indexed. You can include everything or pick specific folders.
                </p>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Label className="text-xs">Include everything</Label>
                  <Switch
                    checked={state.includeAll}
                    onCheckedChange={(checked) => {
                      if (checked) selectAll();
                      else deselectAll();
                    }}
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={selectAll}>
                    Select All
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={deselectAll}>
                    Deselect All
                  </Button>
                </div>
              </div>

              {state.scanResult && state.scanResult.folders.length > 0 && (
                <Card>
                  <CardContent className="p-3 max-h-[340px] overflow-y-auto">
                    <FolderTreeView
                      nodes={state.scanResult.folders}
                      selectedFolders={state.selectedFolders}
                      onToggle={toggleFolder}
                    />
                  </CardContent>
                </Card>
              )}

              <div className="flex items-center gap-2 rounded-lg bg-muted p-3">
                <FolderTree className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-xs text-muted-foreground">
                  Selected: {selectedFileCount} files from {state.selectedFolders.size} folders
                </span>
              </div>

              <div className="flex justify-between pt-2">
                <Button variant="outline" onClick={goBack}>
                  <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
                  Back
                </Button>
                <Button onClick={goNext} disabled={state.selectedFolders.size === 0}>
                  Next
                  <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 4 — Configuration */}
          {state.step === 4 && (
            <div className="space-y-4 mt-6">
              <div>
                <h2 className="text-lg font-medium">Configuration</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Name your knowledge source and optionally configure git sync.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Name</Label>
                  <Input
                    value={state.name}
                    onChange={(e) => update({ name: e.target.value })}
                    placeholder="Engineering Docs"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Git remote URL (optional)</Label>
                  <Input
                    value={state.gitRemoteUrl}
                    onChange={(e) => update({ gitRemoteUrl: e.target.value })}
                    placeholder="git@github.com:company/docs.git"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    If configured, the vault can be synced from this remote.
                  </p>
                </div>
              </div>

              <div className="flex justify-between pt-4">
                <Button variant="outline" onClick={goBack}>
                  <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
                  Back
                </Button>
                <Button onClick={goNext} disabled={!state.name.trim()}>
                  Next
                  <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 5 — Review */}
          {state.step === 5 && (
            <div className="space-y-4 mt-6">
              <div>
                <h2 className="text-lg font-medium">Review & Create</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Confirm the details below and create the knowledge source.
                </p>
              </div>

              <Card>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                      {state.sourceType === 'obsidian' ? (
                        <BookOpen className="h-5 w-5" />
                      ) : (
                        <Folder className="h-5 w-5" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{state.name}</p>
                      <Badge variant="outline" className="text-[10px]">
                        {state.sourceType === 'obsidian' ? 'Obsidian Vault' : 'Filesystem'}
                      </Badge>
                    </div>
                  </div>

                  <div className="border-t border-border pt-3 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Path</span>
                      <span className="font-mono text-[11px]">{state.path}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Scope</span>
                      <span>{state.includeAll ? 'Everything' : `${state.selectedFolders.size} folders`}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Files</span>
                      <span>{selectedFileCount} files</span>
                    </div>
                    {state.gitRemoteUrl && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Git remote</span>
                        <span className="font-mono text-[11px] truncate max-w-[200px]">{state.gitRemoteUrl}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {createMutation.isError && (
                <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{(createMutation.error as Error)?.message || 'Failed to create source'}</span>
                </div>
              )}

              <div className="flex justify-between pt-4">
                <Button variant="outline" onClick={goBack}>
                  <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
                  Back
                </Button>
                <Button
                  onClick={() => createMutation.mutate()}
                  disabled={createMutation.isPending}
                  className="gap-1.5"
                >
                  {createMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileText className="h-3.5 w-3.5" />
                  )}
                  Create & Start Indexing
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
