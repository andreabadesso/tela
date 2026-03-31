import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Settings as SettingsIcon, Copy, Check, Eye, EyeOff, Shield, Bell, Globe, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { api, type SettingEntry } from '@/lib/api';

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
];

const MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4',
  'gpt-4o',
  'gpt-4o-mini',
];

function settingsToMap(settings: SettingEntry[]): Map<string, string> {
  return new Map(settings.map((s) => [s.key, s.value]));
}

function MaskedField({ value }: { value: string; label?: string }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  const masked = value ? value.slice(0, 4) + '*'.repeat(Math.max(0, value.length - 8)) + value.slice(-4) : '';

  const copy = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [value]);

  if (!value) return <span className="text-xs text-muted-foreground">Not configured</span>;

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono">
        {visible ? value : masked}
      </code>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setVisible(!visible)} title={visible ? 'Hide' : 'Show'}>
        {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copy} title="Copy">
        {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

export function Settings() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
    refetchInterval: 30000,
  });

  const settingsMap = settings ? settingsToMap(settings) : new Map<string, string>();

  // Local state for editable fields
  const [companyName, setCompanyName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [defaultModel, setDefaultModel] = useState('claude-sonnet-4-6');

  // Sync local state when settings load
  useEffect(() => {
    if (settings) {
      const m = settingsToMap(settings);
      setCompanyName(m.get('company_name') ?? '');
      setTimezone(m.get('timezone') ?? 'UTC');
      setDefaultModel(m.get('default_model') ?? 'claude-sonnet-4-6');
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => api.setSetting(key, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const saveField = useCallback(
    (key: string, value: string) => {
      saveMutation.mutate({ key, value });
    },
    [saveMutation]
  );

  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm text-muted-foreground">Loading settings...</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <SettingsIcon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Settings</span>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4 max-w-2xl">
        {/* General */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">General</CardTitle>
            </div>
            <CardDescription className="text-xs">Basic application configuration</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Company Name</Label>
              <div className="flex items-center gap-2">
                <Input
                  className="h-8 text-sm"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Your Company"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => saveField('company_name', companyName)}
                  disabled={saveMutation.isPending}
                >
                  Save
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Timezone</Label>
              <div className="flex items-center gap-2">
                <Select value={timezone} onValueChange={(v: string | null) => { if (v) { setTimezone(v); saveField('timezone', v); } }}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map((tz) => (
                      <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Default Model</Label>
              <div className="flex items-center gap-2">
                <Select value={defaultModel} onValueChange={(v: string | null) => { if (v) { setDefaultModel(v); saveField('default_model', v); } }}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODELS.map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Notifications */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Notifications</CardTitle>
            </div>
            <CardDescription className="text-xs">Notification channel configuration</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Telegram Bot Token</Label>
              <MaskedField value={settingsMap.get('telegram_bot_token') ?? ''} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Telegram Chat ID</Label>
              <MaskedField value={settingsMap.get('telegram_chat_id') ?? ''} />
            </div>
            <Separator />
            <p className="text-xs text-muted-foreground">
              Additional notification channels (Slack, Email, Discord) coming soon.
            </p>
          </CardContent>
        </Card>

        {/* Security */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">Security</CardTitle>
            </div>
            <CardDescription className="text-xs">Authentication and encryption</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">API Token</Label>
              <MaskedField value={settingsMap.get('api_token') ?? localStorage.getItem('api_token') ?? ''} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Encryption Key</Label>
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${
                  settingsMap.get('encryption_key_set') === 'true'
                    ? 'bg-green-500/15 text-green-400 border-green-500/30'
                    : 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
                }`}>
                  {settingsMap.get('encryption_key_set') === 'true' ? 'Configured' : 'Not Configured'}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* About */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm">About</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-xs text-muted-foreground">Version</span>
                <p className="font-mono text-xs">v0.1.0</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Uptime</span>
                <p className="font-mono text-xs">
                  {health ? formatUptime((health as { uptime: number }).uptime) : '-'}
                </p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Status</span>
                <p className="font-mono text-xs">
                  {health ? (
                    <span className="text-green-400">Healthy</span>
                  ) : (
                    <span className="text-red-400">Unreachable</span>
                  )}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
