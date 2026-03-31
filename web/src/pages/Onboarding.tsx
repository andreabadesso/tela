import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowRight, Loader2, Sparkles, Wrench } from 'lucide-react';
import { api, type OnboardingStatus } from '@/lib/api';

interface OnboardingProps {
  userName: string;
  onComplete: () => void;
}

export function Onboarding({ userName, onComplete }: OnboardingProps) {
  const [completing, setCompleting] = useState(false);

  const { data: status, isLoading } = useQuery<OnboardingStatus>({
    queryKey: ['onboarding'],
    queryFn: api.getOnboarding,
  });

  const handleGetStarted = async () => {
    setCompleting(true);
    try {
      await api.completeOnboarding();
      onComplete();
    } catch (err) {
      console.error('Onboarding completion failed:', err);
    } finally {
      setCompleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const firstName = userName?.split(' ')[0] || 'there';

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg">
        <Card className="border-border bg-card">
          <CardContent className="flex flex-col gap-6 p-8">
            {/* Welcome header */}
            <div className="text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground text-2xl font-bold mx-auto mb-4">
                T
              </div>
              <h1 className="text-2xl font-bold tracking-tight">
                Hi {firstName}! Welcome to Tela.
              </h1>
              <p className="text-muted-foreground mt-2">
                Your AI-powered workplace assistant is ready.
              </p>
            </div>

            {/* Role info */}
            {status && (
              <div className="space-y-4">
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Sparkles className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">Your Role</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {status.roles.map((role) => (
                      <Badge key={role} variant="secondary" className="capitalize">
                        {role}
                      </Badge>
                    ))}
                  </div>
                  {status.teams.length > 0 && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      Teams: {status.teams.join(', ')}
                    </div>
                  )}
                </div>

                {/* Available tools */}
                {status.tools.length > 0 && (
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Wrench className="h-4 w-4 text-primary" />
                      <span className="text-sm font-medium">Available Tools</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {status.tools.map((tool) => (
                        <Badge key={tool.name} variant="outline" className="text-xs">
                          {tool.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Get started */}
            <Button
              size="lg"
              className="w-full gap-2"
              onClick={handleGetStarted}
              disabled={completing}
            >
              {completing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  Get Started <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
