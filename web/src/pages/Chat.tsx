import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AssistantRuntimeProvider } from '@assistant-ui/core/react';
import { Thread } from '@/components/assistant-ui/thread';
import { AgentPickerModal } from '@/components/chat/AgentPicker';
import { Plus, MessageSquare, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, type ChatThread } from '@/lib/api';
import { useTelaRuntime } from '@/lib/tela-runtime';
import { cn } from '@/lib/utils';

export function Chat({ initialThreadId }: { initialThreadId?: string }) {
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>();
  const [selectedAgentName, setSelectedAgentName] = useState<string | undefined>();
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThreadId ?? null);
  const [showAgentPicker, setShowAgentPicker] = useState(false);

  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.getAgents(),
    retry: false,
  });

  const { data: threads = [], refetch: refetchThreads } = useQuery({
    queryKey: ['chat-threads'],
    queryFn: () => api.getThreads(),
  });

  const { runtime, currentThreadId } = useTelaRuntime(selectedAgent, activeThreadId);

  // Sync currentThreadId back (auto-created threads)
  useEffect(() => {
    if (currentThreadId && currentThreadId !== activeThreadId) {
      setActiveThreadId(currentThreadId);
      void refetchThreads();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentThreadId]);

  // Parse thread ID from hash
  useEffect(() => {
    const match = window.location.hash.match(/^#\/chat\/(.+)$/);
    if (match) {
      setActiveThreadId(match[1]);
    }
  }, []);

  // When opening a thread, lock agent to the thread's agent
  useEffect(() => {
    if (activeThreadId) {
      const thread = threads.find((t) => t.id === activeThreadId);
      if (thread) {
        const agent = agents.find((a) => a.id === thread.agent_id);
        setSelectedAgent(thread.agent_id !== 'default' ? thread.agent_id : undefined);
        setSelectedAgentName(agent?.name);
      }
    }
  }, [activeThreadId, threads, agents]);

  function startNewChat() {
    // Show the agent picker modal
    setShowAgentPicker(true);
  }

  function handleAgentSelected(agent: { id: string; name: string }) {
    setShowAgentPicker(false);
    setSelectedAgent(agent.id);
    setSelectedAgentName(agent.name);
    setActiveThreadId(null);
    window.history.replaceState(null, '', '#/');
  }

  function openThread(thread: ChatThread) {
    setActiveThreadId(thread.id);
    const agent = agents.find((a) => a.id === thread.agent_id);
    setSelectedAgent(thread.agent_id !== 'default' ? thread.agent_id : undefined);
    setSelectedAgentName(agent?.name);
    window.history.replaceState(null, '', `#/chat/${thread.id}`);
  }

  async function deleteThread(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await api.deleteThread(id);
    if (activeThreadId === id) {
      setActiveThreadId(null);
      setSelectedAgent(undefined);
      setSelectedAgentName(undefined);
      window.history.replaceState(null, '', '#/');
    }
    refetchThreads();
  }

  // Resolve display name for current agent
  const agentLabel = selectedAgentName || agents.find((a) => a.id === selectedAgent)?.name;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full">
        {/* Thread sidebar */}
        <div className="w-56 shrink-0 border-r border-border flex flex-col bg-muted/20">
          <div className="p-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full h-8 gap-1.5 text-xs justify-start"
              onClick={startNewChat}
            >
              <Plus className="h-3 w-3" />
              New Chat
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto px-1">
            {threads.map((thread) => (
              <div
                key={thread.id}
                role="button"
                tabIndex={0}
                onClick={() => openThread(thread)}
                onKeyDown={(e) => e.key === 'Enter' && openThread(thread)}
                className={cn(
                  'group flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left transition-colors mb-0.5 cursor-pointer',
                  activeThreadId === thread.id
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                <MessageSquare className="h-3 w-3 shrink-0" />
                <span className="text-xs truncate flex-1">
                  {thread.title || 'Untitled'}
                </span>
                <button
                  onClick={(e) => deleteThread(thread.id, e)}
                  className="h-4 w-4 shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            {threads.length === 0 && (
              <p className="text-[10px] text-muted-foreground/50 text-center py-4 px-2">
                No conversations yet
              </p>
            )}
          </div>
        </div>

        {/* Chat area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top bar — shows locked agent name */}
          {agentLabel && (
            <div className="flex h-10 items-center border-b border-border px-4">
              <span className="text-xs font-medium text-muted-foreground">
                Talking to <span className="text-foreground">{agentLabel}</span>
              </span>
            </div>
          )}

          {/* Thread */}
          <div className="flex-1 overflow-hidden">
            <Thread />
          </div>
        </div>
      </div>

      {/* Agent picker modal */}
      <AgentPickerModal
        agents={agents}
        open={showAgentPicker}
        onSelect={handleAgentSelected}
        onClose={() => setShowAgentPicker(false)}
      />
    </AssistantRuntimeProvider>
  );
}
