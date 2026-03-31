import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Link2,
  GitFork,
  Calendar,
  TicketCheck,
  BarChart3,
  Server,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  Unplug,
  ExternalLink,
  Shield,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';

// ─── Icon mapping ──────────────────────────────────────────────

const TYPE_ICONS: Record<string, React.ReactNode> = {
  github: <GitFork className="h-6 w-6" />,
  jira: <TicketCheck className="h-6 w-6" />,
  google: <Calendar className="h-6 w-6" />,
  shiplens: <BarChart3 className="h-6 w-6" />,
  api_key: <Server className="h-6 w-6" />,
};

function getIcon(type: string) {
  return TYPE_ICONS[type] || <Link2 className="h-6 w-6" />;
}

function statusBadge(status: string) {
  switch (status) {
    case 'connected':
      return (
        <Badge variant="outline" className="gap-1 border-green-800 text-green-400">
          <CheckCircle2 className="h-3 w-3" /> Connected
        </Badge>
      );
    case 'error':
      return (
        <Badge variant="outline" className="gap-1 border-red-800 text-red-400">
          <XCircle className="h-3 w-3" /> Error
        </Badge>
      );
    case 'not_connected':
      return (
        <Badge variant="outline" className="gap-1 border-zinc-700 text-zinc-400">
          <AlertCircle className="h-3 w-3" /> Not Connected
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="gap-1 border-zinc-700 text-zinc-400">
          <AlertCircle className="h-3 w-3" /> {status}
        </Badge>
      );
  }
}

export function MyConnections() {
  const queryClient = useQueryClient();
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const { data: connections = [], isLoading } = useQuery({
    queryKey: ['my-connections'],
    queryFn: api.getMyConnections,
  });

  const testMutation = useMutation({
    mutationFn: (connectionId: string) => api.testUserConnection(connectionId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['my-connections'] }),
  });

  const disconnectMutation = useMutation({
    mutationFn: (connectionId: string) => api.disconnectUserConnection(connectionId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['my-connections'] }),
  });

  // Listen for OAuth popup callback
  const handleOAuthMessage = useCallback((event: MessageEvent) => {
    if (event.data?.type === 'oauth-callback') {
      setConnectingId(null);
      queryClient.invalidateQueries({ queryKey: ['my-connections'] });
    }
  }, [queryClient]);

  useEffect(() => {
    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [handleOAuthMessage]);

  const handleConnect = async (connectionId: string) => {
    setConnectingId(connectionId);
    try {
      const { authUrl } = await api.initiateUserOAuth(connectionId);
      // Open OAuth in a popup
      const popup = window.open(authUrl, 'oauth-popup', 'width=600,height=700,scrollbars=yes');
      if (!popup) {
        // Popup blocked — redirect instead
        window.location.href = authUrl;
      }
    } catch (err) {
      console.error('Failed to initiate OAuth:', err);
      setConnectingId(null);
    }
  };

  const delegated = connections.filter((c) => c.token_strategy === 'delegated');
  const company = connections.filter((c) => c.token_strategy === 'company');

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">My Connections</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your personal account connections to company tools.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Delegated connections — user can connect/disconnect */}
          {delegated.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Personal Connections
              </h2>
              <div className="grid gap-3">
                {delegated.map((conn) => (
                  <Card key={conn.id} className="bg-card border-border">
                    <CardContent className="flex items-center gap-4 p-4">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground shrink-0">
                        {getIcon(conn.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{conn.name}</span>
                          {statusBadge(conn.user_status)}
                        </div>
                        {conn.error_message && (
                          <p className="text-xs text-red-400 mt-1 truncate">{conn.error_message}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {conn.user_status === 'connected' ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => testMutation.mutate(conn.id)}
                              disabled={testMutation.isPending}
                            >
                              {testMutation.isPending ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                'Test'
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-red-400 hover:text-red-300"
                              onClick={() => disconnectMutation.mutate(conn.id)}
                              disabled={disconnectMutation.isPending}
                            >
                              <Unplug className="h-3.5 w-3.5 mr-1" />
                              Disconnect
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => handleConnect(conn.id)}
                            disabled={connectingId === conn.id}
                          >
                            {connectingId === conn.id ? (
                              <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            ) : (
                              <ExternalLink className="h-3.5 w-3.5 mr-1" />
                            )}
                            Connect
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {/* Company-managed connections */}
          {company.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Company Connections
              </h2>
              <div className="grid gap-3">
                {company.map((conn) => (
                  <Card key={conn.id} className="bg-card border-border">
                    <CardContent className="flex items-center gap-4 p-4">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground shrink-0">
                        {getIcon(conn.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{conn.name}</span>
                          {statusBadge(conn.company_status)}
                        </div>
                      </div>
                      <Badge variant="secondary" className="gap-1 shrink-0">
                        <Shield className="h-3 w-3" />
                        Managed by admin
                      </Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          )}

          {connections.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Link2 className="h-12 w-12 mx-auto mb-3 opacity-40" />
              <p className="text-lg font-medium">No connections available</p>
              <p className="text-sm mt-1">Your admin hasn't configured any integrations yet.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
