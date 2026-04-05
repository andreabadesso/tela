import { useQuery } from '@tanstack/react-query';
import {
  Database, Code2, HardDrive, Globe, Activity,
  Table2, ExternalLink, Layers,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const FN_STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-400',
  draft: 'bg-amber-500/10 text-amber-400',
  error: 'bg-red-500/10 text-red-400',
};

const DEPLOY_STATUS_STYLES: Record<string, string> = {
  READY: 'bg-emerald-500/10 text-emerald-400',
  BUILDING: 'bg-blue-500/10 text-blue-400',
  QUEUED: 'bg-amber-500/10 text-amber-400',
  ERROR: 'bg-red-500/10 text-red-400',
  CANCELED: 'bg-muted text-muted-foreground',
};

function formatSize(gb: number): string {
  if (gb < 0.001) return `${Math.round(gb * 1024 * 1024)} KB`;
  if (gb < 1) return `${(gb * 1024).toFixed(1)} MB`;
  return `${gb.toFixed(2)} GB`;
}

export function Services() {
  const { data: services, isLoading, error } = useQuery({
    queryKey: ['insforge-services'],
    queryFn: () => api.getServices(),
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Activity className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !services) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="text-xl font-semibold mb-2">Services</h1>
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          InsForge is not reachable. Make sure the InsForge stack is running.
        </div>
      </div>
    );
  }

  const { database, functions, storage, deployments } = services;
  const totalTables = database.tables.length;
  const totalRecords = database.tables.reduce((sum, t) => sum + t.recordCount, 0);
  const totalFunctions = functions.length;
  const activeFunctions = functions.filter((f) => f.status === 'active').length;
  const totalBuckets = storage.buckets.length;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Services</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Backend resources provisioned by your agents via InsForge
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <SummaryCard
          icon={<Database className="h-4 w-4" />}
          label="Tables"
          value={totalTables}
          sub={`${totalRecords.toLocaleString()} records`}
          color="text-blue-400"
        />
        <SummaryCard
          icon={<Code2 className="h-4 w-4" />}
          label="Functions"
          value={totalFunctions}
          sub={`${activeFunctions} active`}
          color="text-violet-400"
        />
        <SummaryCard
          icon={<HardDrive className="h-4 w-4" />}
          label="Buckets"
          value={totalBuckets}
          sub={formatSize(storage.totalSizeInGB)}
          color="text-amber-400"
        />
        <SummaryCard
          icon={<Globe className="h-4 w-4" />}
          label="Deployments"
          value={deployments.length}
          sub={deployments.filter((d) => d.status === 'READY').length + ' live'}
          color="text-emerald-400"
        />
      </div>

      {/* Database tables */}
      <Section
        icon={<Database className="h-4 w-4 text-blue-400" />}
        title="Database"
        badge={formatSize(database.totalSizeInGB)}
      >
        {database.tables.length === 0 ? (
          <EmptyState text="No tables created yet" />
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Table</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground">Records</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-muted-foreground">API</th>
                </tr>
              </thead>
              <tbody>
                {database.tables.map((table) => (
                  <tr key={table.tableName} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-mono text-xs">{table.tableName}</span>
                      </div>
                    </td>
                    <td className="text-right px-4 py-2.5 tabular-nums text-muted-foreground">
                      {table.recordCount.toLocaleString()}
                    </td>
                    <td className="text-right px-4 py-2.5">
                      <a
                        href={`http://localhost:5430/${table.tableName}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        REST
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Edge Functions */}
      <Section
        icon={<Code2 className="h-4 w-4 text-violet-400" />}
        title="Edge Functions"
      >
        {functions.length === 0 ? (
          <EmptyState text="No edge functions deployed" />
        ) : (
          <div className="grid gap-2">
            {functions.map((fn) => (
              <div
                key={fn.slug}
                className="flex items-center justify-between rounded-lg border border-border px-4 py-3 hover:bg-muted/20 transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{fn.name}</span>
                    <Badge variant="outline" className={cn('text-[10px]', FN_STATUS_STYLES[fn.status] ?? '')}>
                      {fn.status}
                    </Badge>
                  </div>
                  {fn.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{fn.description}</p>
                  )}
                </div>
                <a
                  href={`http://localhost:7133/${fn.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 ml-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span className="font-mono">/{fn.slug}</span>
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Storage Buckets */}
      <Section
        icon={<HardDrive className="h-4 w-4 text-amber-400" />}
        title="Storage"
        badge={formatSize(storage.totalSizeInGB)}
      >
        {storage.buckets.length === 0 ? (
          <EmptyState text="No storage buckets created" />
        ) : (
          <div className="grid gap-2">
            {storage.buckets.map((bucket) => (
              <div
                key={bucket.name}
                className="flex items-center justify-between rounded-lg border border-border px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium">{bucket.name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {bucket.public ? 'public' : 'private'}
                  </Badge>
                </div>
                {bucket.objectCount != null && (
                  <span className="text-xs text-muted-foreground">{bucket.objectCount} objects</span>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Deployments */}
      <Section
        icon={<Globe className="h-4 w-4 text-emerald-400" />}
        title="Deployments"
      >
        {deployments.length === 0 ? (
          <EmptyState text="No deployments yet" />
        ) : (
          <div className="grid gap-2">
            {deployments.map((dep) => (
              <div
                key={dep.id}
                className="flex items-center justify-between rounded-lg border border-border px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{dep.provider}</span>
                  <Badge variant="outline" className={cn('text-[10px]', DEPLOY_STATUS_STYLES[dep.status] ?? '')}>
                    {dep.status}
                  </Badge>
                </div>
                {dep.url && (
                  <a
                    href={dep.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {dep.url}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function SummaryCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub: string;
  color: string;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className={cn('flex items-center gap-1.5 text-xs mb-2', color)}>
        {icon}
        <span className="font-medium">{label}</span>
      </div>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>
    </div>
  );
}

function Section({ icon, title, badge, children }: {
  icon: React.ReactNode;
  title: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <h2 className="text-sm font-medium">{title}</h2>
        {badge && (
          <span className="text-[10px] text-muted-foreground bg-muted rounded-full px-2 py-0.5">{badge}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}
