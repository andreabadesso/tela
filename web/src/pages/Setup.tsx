import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowRight, Building2, Sparkles, Check } from 'lucide-react';
import { api } from '@/lib/api';

type Step = 'welcome' | 'company' | 'done';

export function Setup({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [companyName, setCompanyName] = useState('');
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [saving, setSaving] = useState(false);

  const handleFinish = async () => {
    setSaving(true);
    try {
      await api.completeSetup({
        companyName: companyName || undefined,
        timezone: timezone || undefined,
      });
      setStep('done');
      // Brief pause before redirecting
      setTimeout(() => onComplete(), 1500);
    } catch (err) {
      console.error('Setup completion failed:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        {step === 'welcome' && (
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center gap-6 p-8 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground text-2xl font-bold">
                T
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">Welcome to Tela</h1>
                <p className="text-muted-foreground mt-2">
                  Let's set up your company's AI-powered operating system.
                  This will only take a minute.
                </p>
              </div>
              <Button size="lg" className="w-full gap-2" onClick={() => setStep('company')}>
                Get Started <ArrowRight className="h-4 w-4" />
              </Button>
            </CardContent>
          </Card>
        )}

        {step === 'company' && (
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col gap-6 p-8">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                  <Building2 className="h-5 w-5 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">Company Info</h2>
                  <p className="text-sm text-muted-foreground">Basic details about your organization</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="company-name">Company Name</Label>
                  <Input
                    id="company-name"
                    placeholder="Acme Corp"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="timezone">Timezone</Label>
                  <Input
                    id="timezone"
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Auto-detected from your browser. Change if needed.
                  </p>
                </div>
              </div>

              <Button
                size="lg"
                className="w-full gap-2"
                onClick={handleFinish}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Complete Setup'}
                {!saving && <Sparkles className="h-4 w-4" />}
              </Button>
            </CardContent>
          </Card>
        )}

        {step === 'done' && (
          <Card className="border-border bg-card">
            <CardContent className="flex flex-col items-center gap-6 p-8 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-900/30 text-green-400">
                <Check className="h-8 w-8" />
              </div>
              <div>
                <h2 className="text-2xl font-bold">You're all set!</h2>
                <p className="text-muted-foreground mt-2">
                  Tela is ready. Redirecting to your dashboard...
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
