import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { Thread } from '@/components/assistant-ui/thread';
import { api, type ProjectSession } from '@/lib/api';
import { useProjectChatRuntime } from '@/lib/project-session-runtime';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ExternalLink, ArrowLeft, Loader2, RefreshCw, LayoutPanelLeft } from 'lucide-react';

function isActiveSession(session: ProjectSession): boolean {
  return session.status === 'pending' || session.status === 'running';
}

export function ProjectChat({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [showPreview, setShowPreview] = useState(true);
  const [previewKey, setPreviewKey] = useState(0);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevActiveRef = useRef(false);

  const { data: project, isLoading: projectLoading } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
  });

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => api.getProjectSessions(projectId),
  });

  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: api.getAgents,
  });

  // Default to first agent
  useEffect(() => {
    if (agents.length > 0 && !selectedAgentId) {
      const appBuilder = agents.find((a) =>
        a.name?.toLowerCase().includes('app') || a.description?.toLowerCase().includes('app')
      );
      setSelectedAgentId(appBuilder?.id ?? agents[0].id);
    }
  }, [agents, selectedAgentId]);

  const hasActiveSession = sessions.some(isActiveSession);

  // Poll while active
  useEffect(() => {
    if (hasActiveSession) {
      pollingRef.current = setInterval(() => {
        queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
        queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      }, 3000);
    } else {
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
    }
    return () => { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } };
  }, [hasActiveSession, projectId, queryClient]);

  // Auto-refresh preview when a session just committed
  useEffect(() => {
    if (prevActiveRef.current && !hasActiveSession) {
      setPreviewKey((k) => k + 1);
    }
    prevActiveRef.current = hasActiveSession;
  }, [hasActiveSession]);

  const startMutation = useMutation({
    mutationFn: () => api.startProjectSession(projectId, message.trim(), selectedAgentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      setMessage('');
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (sessionId: string) => api.cancelProjectSession(projectId, sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] }),
  });

  const { runtime, isRunning } = useProjectChatRuntime(projectId, sessions);

  const appUrl = project?.app_url ?? null;
  const activeSession = sessions.find(isActiveSession) ?? null;

  if (projectLoading || sessionsLoading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-sm text-muted-foreground">Project not found.</p>
        <Button variant="outline" size="sm" onClick={() => { window.location.hash = '#/projects'; }}>
          <ArrowLeft className="h-4 w-4 mr-1.5" />Back to Projects
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
            onClick={() => { window.location.hash = '#/projects'; }}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Projects
          </button>
          <span className="text-muted-foreground/40 text-xs">/</span>
          <h1 className="text-sm font-semibold truncate">{project.name}</h1>
          {hasActiveSession && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" />}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {appUrl && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setPreviewKey((k) => k + 1)}
                title="Refresh preview"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={showPreview ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setShowPreview((v) => !v)}
                title="Toggle preview"
              >
                <LayoutPanelLeft className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
                <a href={appUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3 w-3 mr-1.5" />View App
                </a>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Main area: chat + optional preview */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chat column */}
        <div className="flex flex-col min-w-0 overflow-hidden" style={{ flex: showPreview && appUrl ? '0 0 50%' : '1 1 0' }}>
          {/* Thread */}
          <div className="flex-1 overflow-hidden">
            <AssistantRuntimeProvider runtime={runtime}>
              {sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
                  <p className="text-sm font-medium">Start building</p>
                  <p className="text-xs text-muted-foreground max-w-xs">
                    Describe what you want to build. The agent will work in a sandboxed container, commit the code, and deploy automatically.
                  </p>
                </div>
              ) : (
                <Thread readOnly threadId={projectId} />
              )}
            </AssistantRuntimeProvider>
          </div>

          {/* Input */}
          <div className="border-t border-border px-4 py-3 shrink-0">
            {hasActiveSession ? (
              <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-2.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" />
                <p className="text-xs text-muted-foreground flex-1">Agent is working...</p>
                {activeSession && (
                  <Button
                    variant="outline" size="sm" className="h-6 text-xs shrink-0"
                    onClick={() => cancelMutation.mutate(activeSession.id)}
                    disabled={cancelMutation.isPending}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Textarea
                  placeholder="Describe what you want to build or change..."
                  rows={2}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      if (message.trim() && selectedAgentId) startMutation.mutate();
                    }
                  }}
                  disabled={startMutation.isPending}
                  className="resize-none"
                />
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted-foreground shrink-0">Agent:</label>
                    <Select value={selectedAgentId} onValueChange={setSelectedAgentId} disabled={agents.length === 0}>
                      <SelectTrigger className="h-6 text-xs w-36">
                        <SelectValue placeholder="Select agent" />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map((agent) => (
                          <SelectItem key={agent.id} value={agent.id} className="text-xs">{agent.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <p className="text-[10px] text-muted-foreground">⌘↵</p>
                    <Button
                      size="sm" className="h-6 text-xs"
                      onClick={() => startMutation.mutate()}
                      disabled={!message.trim() || !selectedAgentId || startMutation.isPending}
                    >
                      {startMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Send'}
                    </Button>
                  </div>
                </div>
                {startMutation.isError && (
                  <p className="text-xs text-destructive">{(startMutation.error as Error).message}</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Preview pane */}
        {showPreview && appUrl && (
          <div className="flex flex-col border-l border-border overflow-hidden" style={{ flex: '0 0 50%' }}>
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0 bg-muted/20">
              <span className="text-xs text-muted-foreground font-medium">Preview</span>
              <div className="flex items-center gap-1">
                {isRunning && <span className="text-[10px] text-blue-400 animate-pulse">Building...</span>}
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => setPreviewKey((k) => k + 1)}>
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </div>
            </div>
            <iframe
              key={previewKey}
              src={appUrl}
              className="flex-1 w-full border-0 bg-white"
              title="App preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        )}
      </div>
    </div>
  );
}
