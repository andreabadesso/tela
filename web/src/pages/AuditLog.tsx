import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollText, ChevronDown, ChevronRight, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, type AuditEntry } from '@/lib/api';

const PAGE_SIZE = 25;

const ACTION_BADGES: Record<string, string> = {
  tool_call: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  mcp_request: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  knowledge_read: 'bg-green-500/15 text-green-400 border-green-500/30',
  knowledge_write: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  schedule_run: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
};

const DECISION_BADGES: Record<string, string> = {
  allowed: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  denied: 'bg-red-500/15 text-red-400 border-red-500/30',
  rate_limited: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
};

function ActionBadge({ action }: { action: string }) {
  const cls = ACTION_BADGES[action] ?? 'bg-muted text-muted-foreground border-border';
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {action}
    </span>
  );
}

function DecisionBadge({ decision }: { decision: string | null | undefined }) {
  if (!decision) return <span className="text-xs text-muted-foreground">-</span>;
  const cls = DECISION_BADGES[decision] ?? 'bg-muted text-muted-foreground border-border';
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {decision}
    </span>
  );
}

function UserCell({ entry }: { entry: AuditEntry }) {
  if (!entry.user_name) return <span className="text-xs text-muted-foreground">-</span>;
  return (
    <div className="flex items-center gap-1.5">
      {entry.user_image ? (
        <img
          src={entry.user_image}
          alt={entry.user_name}
          className="h-5 w-5 rounded-full shrink-0"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium shrink-0">
          {entry.user_name.charAt(0).toUpperCase()}
        </div>
      )}
      <span className="text-xs truncate">{entry.user_name}</span>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function ExpandableRow({ entry, agentName }: { entry: AuditEntry; agentName: string }) {
  const [open, setOpen] = useState(false);
  let details: Record<string, unknown> = {};
  try {
    details = JSON.parse(entry.details);
  } catch {
    // ignore
  }

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-accent/50"
        onClick={() => setOpen(!open)}
      >
        <TableCell className="w-8 pr-0">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
          {formatDate(entry.created_at)}
        </TableCell>
        <TableCell>
          <UserCell entry={entry} />
        </TableCell>
        <TableCell className="text-sm">{agentName}</TableCell>
        <TableCell>
          <ActionBadge action={entry.action} />
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">{entry.connection_name ?? entry.source}</TableCell>
        <TableCell className="text-xs text-muted-foreground">{entry.tool_name ?? '-'}</TableCell>
        <TableCell>
          <DecisionBadge decision={entry.access_decision} />
        </TableCell>
        <TableCell className="text-xs text-muted-foreground text-right">
          {entry.duration_ms != null ? `${entry.duration_ms}ms` : '-'}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={9} className="bg-muted/30 p-4">
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-64 overflow-auto">
              {JSON.stringify(details, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

interface AuditLogProps {
  isAdmin?: boolean;
}

export function AuditLog({ isAdmin }: AuditLogProps) {
  const [page, setPage] = useState(0);
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [actionFilter, setActionFilter] = useState<string>('');
  const [sourceFilter, setSourceFilter] = useState<string>('');
  const [userFilter, setUserFilter] = useState<string>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.getAgents(),
    retry: false,
  });

  // Load users list for admin filter
  const { data: allUsers } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.getUsers(),
    enabled: !!isAdmin,
    retry: false,
  });

  const agentMap = new Map(agents?.map((a) => [a.id, a.name]) ?? []);

  const queryParams = useCallback(() => {
    const p: Record<string, string | number> = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    if (agentFilter) p.agent_id = agentFilter;
    if (actionFilter) p.action = actionFilter;
    if (sourceFilter) p.source = sourceFilter;
    if (userFilter) p.user_id = userFilter;
    if (fromDate) p.from = fromDate;
    if (toDate) p.to = toDate;
    return p as Parameters<typeof api.getAuditLog>[0];
  }, [page, agentFilter, actionFilter, sourceFilter, userFilter, fromDate, toDate]);

  const { data, isLoading } = useQuery({
    queryKey: ['audit', page, agentFilter, actionFilter, sourceFilter, userFilter, fromDate, toDate],
    queryFn: () => api.getAuditLog(queryParams()),
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <ScrollText className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Audit Log</span>
        {data && (
          <span className="ml-auto text-xs text-muted-foreground">
            {data.total} entries
          </span>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Input
          type="date"
          placeholder="From"
          value={fromDate}
          onChange={(e) => { setFromDate(e.target.value); setPage(0); }}
          className="h-8 w-36 text-xs"
        />
        <Input
          type="date"
          placeholder="To"
          value={toDate}
          onChange={(e) => { setToDate(e.target.value); setPage(0); }}
          className="h-8 w-36 text-xs"
        />
        {isAdmin && allUsers && (
          <Select value={userFilter} onValueChange={(v: string | null) => { setUserFilter(!v || v === '_all' ? '' : v); setPage(0); }}>
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue placeholder="All users" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all">All users</SelectItem>
              {allUsers.map((u) => (
                <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={agentFilter} onValueChange={(v: string | null) => { setAgentFilter(!v || v === '_all' ? '' : v); setPage(0); }}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="All agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All agents</SelectItem>
            {agents?.map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={actionFilter} onValueChange={(v: string | null) => { setActionFilter(!v || v === '_all' ? '' : v); setPage(0); }}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All actions</SelectItem>
            <SelectItem value="tool_call">tool_call</SelectItem>
            <SelectItem value="mcp_request">mcp_request</SelectItem>
            <SelectItem value="knowledge_read">knowledge_read</SelectItem>
            <SelectItem value="knowledge_write">knowledge_write</SelectItem>
            <SelectItem value="schedule_run">schedule_run</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={(v: string | null) => { setSourceFilter(!v || v === '_all' ? '' : v); setPage(0); }}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue placeholder="All sources" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All sources</SelectItem>
            <SelectItem value="agent">agent</SelectItem>
            <SelectItem value="mcp">mcp</SelectItem>
            <SelectItem value="scheduler">scheduler</SelectItem>
            <SelectItem value="knowledge">knowledge</SelectItem>
            <SelectItem value="web">web</SelectItem>
            <SelectItem value="telegram">telegram</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead className="text-xs">Timestamp</TableHead>
              <TableHead className="text-xs">User</TableHead>
              <TableHead className="text-xs">Agent</TableHead>
              <TableHead className="text-xs">Action</TableHead>
              <TableHead className="text-xs">Connection</TableHead>
              <TableHead className="text-xs">Tool</TableHead>
              <TableHead className="text-xs">Decision</TableHead>
              <TableHead className="text-xs text-right">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-sm text-muted-foreground py-8">
                  Loading...
                </TableCell>
              </TableRow>
            ) : data && data.entries.length > 0 ? (
              data.entries.map((entry) => (
                <ExpandableRow
                  key={entry.id}
                  entry={entry}
                  agentName={entry.agent_id ? (agentMap.get(entry.agent_id) ?? entry.agent_id) : '-'}
                />
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-sm text-muted-foreground py-8">
                  No audit log entries found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2">
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={page >= totalPages - 1}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
