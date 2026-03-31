import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Link2,
  GitFork,
  Calendar,
  TicketCheck,
  BarChart3,
  Server,
  Plug,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  Trash2,
  Zap,
  Key,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { api, type Connection } from '@/lib/api';

// ─── Integration Definitions ────────────────────────────────────

interface IntegrationDef {
  type: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  authMethod: 'oauth' | 'api_key';
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    type: 'github',
    name: 'GitHub',
    description: 'Repositories, pull requests, issues, and code reviews',
    icon: <GitFork className="h-6 w-6" />,
    authMethod: 'oauth',
  },
  {
    type: 'jira',
    name: 'Jira',
    description: 'Project tracking, sprints, and issue management',
    icon: <TicketCheck className="h-6 w-6" />,
    authMethod: 'oauth',
  },
  {
    type: 'google',
    name: 'Google',
    description: 'Calendar events and Gmail integration',
    icon: <Calendar className="h-6 w-6" />,
    authMethod: 'oauth',
  },
  {
    type: 'shiplens',
    name: 'ShipLens',
    description: 'Engineering metrics, DORA, and team analytics',
    icon: <BarChart3 className="h-6 w-6" />,
    authMethod: 'api_key',
  },
  {
    type: 'slack',
    name: 'Slack',
    description: 'Team messaging and notifications',
    icon: <Plug className="h-6 w-6" />,
    authMethod: 'api_key',
  },
  {
    type: 'custom_mcp',
    name: 'Custom MCP',
    description: 'Connect any MCP-compatible server',
    icon: <Server className="h-6 w-6" />,
    authMethod: 'api_key',
  },
];

// ─── Status Badge ───────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'connected':
      return (
        <Badge variant="default" className="bg-emerald-600 hover:bg-emerald-600 gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Connected
        </Badge>
      );
    case 'error':
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="h-3 w-3" />
          Error
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary" className="gap-1">
          <AlertCircle className="h-3 w-3" />
          Disconnected
        </Badge>
      );
  }
}

// ─── Connection Card ────────────────────────────────────────────

function ConnectionCard({
  integration,
  connection,
  onConnect,
  onDisconnect,
  onTest,
  testingType,
}: {
  integration: IntegrationDef;
  connection?: Connection;
  onConnect: (integration: IntegrationDef) => void;
  onDisconnect: (connection: Connection) => void;
  onTest: (type: string) => void;
  testingType: string | null;
}) {
  const isConnected = connection?.status === 'connected';
  const isTesting = testingType === integration.type;

  return (
    <Card className="relative overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              {integration.icon}
            </div>
            <div>
              <h3 className="text-sm font-semibold">{integration.name}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {integration.description}
              </p>
            </div>
          </div>
          {connection && <StatusBadge status={connection.status} />}
        </div>

        {connection?.error_message && (
          <p className="mt-3 text-xs text-destructive bg-destructive/10 rounded px-2 py-1">
            {connection.error_message}
          </p>
        )}

        {connection?.last_sync_at && (
          <p className="mt-2 text-xs text-muted-foreground">
            Last sync: {new Date(connection.last_sync_at).toLocaleString()}
          </p>
        )}

        <div className="mt-4 flex items-center gap-2">
          {isConnected ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onTest(integration.type)}
                disabled={isTesting}
                className="gap-1.5"
              >
                {isTesting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Zap className="h-3 w-3" />
                )}
                Test
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onDisconnect(connection!)}
                className="gap-1.5 text-destructive hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() => onConnect(integration)}
              className="gap-1.5"
            >
              {integration.authMethod === 'oauth' ? (
                <Link2 className="h-3 w-3" />
              ) : (
                <Key className="h-3 w-3" />
              )}
              Connect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ──────────────────────────────────────────────────

export function Connections() {
  const queryClient = useQueryClient();
  const [apiKeyDialog, setApiKeyDialog] = useState<IntegrationDef | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [mcpUrlValue, setMcpUrlValue] = useState('');
  const [deleteDialog, setDeleteDialog] = useState<Connection | null>(null);
  const [testingType, setTestingType] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ type: string; ok: boolean; detail: string } | null>(null);

  const { data: connections = [], isLoading } = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.getConnections(),
  });

  const createMutation = useMutation({
    mutationFn: (data: Parameters<typeof api.createConnection>[0]) => api.createConnection(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      setApiKeyDialog(null);
      setApiKeyValue('');
      setMcpUrlValue('');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connections'] });
      setDeleteDialog(null);
    },
  });

  // Listen for OAuth callback messages
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'oauth-callback') {
        queryClient.invalidateQueries({ queryKey: ['connections'] });
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [queryClient]);

  const handleConnect = useCallback(
    (integration: IntegrationDef) => {
      if (integration.authMethod === 'oauth') {
        // Open OAuth flow in popup
        const url = api.getOAuthUrl(integration.type);
        const width = 600;
        const height = 700;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;
        window.open(
          url,
          'oauth-popup',
          `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
        );
      } else {
        setApiKeyDialog(integration);
      }
    },
    []
  );

  const handleTest = useCallback(async (type: string) => {
    setTestingType(type);
    setTestResult(null);
    try {
      const result = await api.testConnection(type);
      setTestResult({ type, ok: result.ok, detail: result.detail || result.error || '' });
      queryClient.invalidateQueries({ queryKey: ['connections'] });
    } catch (err) {
      setTestResult({ type, ok: false, detail: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTestingType(null);
    }
  }, [queryClient]);

  const handleApiKeySubmit = useCallback(() => {
    if (!apiKeyDialog || !apiKeyValue.trim()) return;
    createMutation.mutate({
      name: apiKeyDialog.name,
      type: apiKeyDialog.type,
      apiKey: apiKeyValue.trim(),
      mcpServerUrl: mcpUrlValue.trim() || undefined,
    });
  }, [apiKeyDialog, apiKeyValue, mcpUrlValue, createMutation]);

  const connectionsByType = new Map(connections.map((c) => [c.type, c]));

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Connections</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {connections.filter((c) => c.status === 'connected').length} of{' '}
          {INTEGRATIONS.length} connected
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Test result toast */}
            {testResult && (
              <div
                className={`mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                  testResult.ok
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-destructive/30 bg-destructive/10 text-destructive'
                }`}
              >
                {testResult.ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0" />
                )}
                <span>{testResult.detail}</span>
                <button
                  onClick={() => setTestResult(null)}
                  className="ml-auto text-muted-foreground hover:text-foreground"
                >
                  &times;
                </button>
              </div>
            )}

            {/* Connection grid */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {INTEGRATIONS.map((integration) => (
                <ConnectionCard
                  key={integration.type}
                  integration={integration}
                  connection={connectionsByType.get(integration.type)}
                  onConnect={handleConnect}
                  onDisconnect={(conn) => setDeleteDialog(conn)}
                  onTest={handleTest}
                  testingType={testingType}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* API Key Dialog */}
      <Dialog open={!!apiKeyDialog} onOpenChange={(open) => !open && setApiKeyDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect {apiKeyDialog?.name}</DialogTitle>
            <DialogDescription>
              Enter your API key to connect {apiKeyDialog?.name}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="api-key">API Key</Label>
              <Input
                id="api-key"
                type="password"
                placeholder="Enter your API key..."
                value={apiKeyValue}
                onChange={(e) => setApiKeyValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleApiKeySubmit()}
              />
            </div>
            {apiKeyDialog?.type === 'custom_mcp' && (
              <div className="space-y-2">
                <Label htmlFor="mcp-url">MCP Server URL</Label>
                <Input
                  id="mcp-url"
                  placeholder="http://localhost:8080"
                  value={mcpUrlValue}
                  onChange={(e) => setMcpUrlValue(e.target.value)}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApiKeyDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleApiKeySubmit}
              disabled={!apiKeyValue.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteDialog} onOpenChange={(open) => !open && setDeleteDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {deleteDialog?.name}?</DialogTitle>
            <DialogDescription>
              This will remove the connection and delete stored credentials. You can reconnect later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteDialog && deleteMutation.mutate(deleteDialog.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
