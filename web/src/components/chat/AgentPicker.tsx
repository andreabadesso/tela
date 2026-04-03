import { useState, useMemo, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Search } from 'lucide-react';

interface Agent {
  id: string;
  name: string;
  description?: string;
}

interface AgentPickerModalProps {
  agents: Agent[];
  open: boolean;
  onSelect: (agent: Agent) => void;
  onClose: () => void;
}

const AGENT_COLORS = [
  'from-blue-500/20 to-blue-600/10 text-blue-400 border-blue-500/20',
  'from-violet-500/20 to-violet-600/10 text-violet-400 border-violet-500/20',
  'from-amber-500/20 to-amber-600/10 text-amber-400 border-amber-500/20',
  'from-emerald-500/20 to-emerald-600/10 text-emerald-400 border-emerald-500/20',
  'from-rose-500/20 to-rose-600/10 text-rose-400 border-rose-500/20',
  'from-cyan-500/20 to-cyan-600/10 text-cyan-400 border-cyan-500/20',
  'from-orange-500/20 to-orange-600/10 text-orange-400 border-orange-500/20',
  'from-pink-500/20 to-pink-600/10 text-pink-400 border-pink-500/20',
];

const AGENT_HOVER_COLORS = [
  'hover:border-blue-400/40 hover:shadow-blue-500/10',
  'hover:border-violet-400/40 hover:shadow-violet-500/10',
  'hover:border-amber-400/40 hover:shadow-amber-500/10',
  'hover:border-emerald-400/40 hover:shadow-emerald-500/10',
  'hover:border-rose-400/40 hover:shadow-rose-500/10',
  'hover:border-cyan-400/40 hover:shadow-cyan-500/10',
  'hover:border-orange-400/40 hover:shadow-orange-500/10',
  'hover:border-pink-400/40 hover:shadow-pink-500/10',
];

function getColorIndex(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % AGENT_COLORS.length;
}

function getInitials(name: string): string {
  const words = name.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function AgentPickerModal({ agents, open, onSelect, onClose }: AgentPickerModalProps) {
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return agents;
    const q = search.toLowerCase();
    return agents.filter(
      (a) => a.name.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q),
    );
  }, [agents, search]);

  // Focus search on open
  useEffect(() => {
    if (open) {
      setSearch('');
      // Small delay to ensure modal is rendered
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-in fade-in-0 duration-150"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-lg mx-4 animate-in fade-in-0 slide-in-from-bottom-4 duration-200">
        <div className="rounded-xl border border-border bg-popover shadow-2xl overflow-hidden">
          {/* Search */}
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search agents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            />
          </div>

          {/* Agent grid */}
          <div className="p-3 max-h-[50vh] overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-8">
                No agents found
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {filtered.map((agent) => {
                  const colorIdx = getColorIndex(agent.id);
                  return (
                    <button
                      key={agent.id}
                      onClick={() => onSelect(agent)}
                      className={cn(
                        'group flex items-start gap-3 rounded-lg border bg-gradient-to-br p-3 text-left transition-all duration-150 hover:shadow-md',
                        AGENT_COLORS[colorIdx],
                        AGENT_HOVER_COLORS[colorIdx],
                      )}
                    >
                      <div className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold',
                        'bg-background/50',
                      )}>
                        {getInitials(agent.name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">
                          {agent.name}
                        </p>
                        {agent.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                            {agent.description}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
