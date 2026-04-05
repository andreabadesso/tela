import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Layout } from '@/components/layout/Layout';
import { Chat } from '@/pages/Chat';
import { Agents } from '@/pages/Agents';
import { AgentEdit } from '@/pages/AgentEdit';
import { Channels } from '@/pages/Channels';
import { Connections } from '@/pages/Connections';
import { MyConnections } from '@/pages/MyConnections';
import { Knowledge } from '@/pages/Knowledge';
import { KnowledgeAdd } from '@/pages/KnowledgeAdd';
import { KnowledgeDetail } from '@/pages/KnowledgeDetail';
import { Schedules } from '@/pages/Schedules';
import { Services } from '@/pages/Services';
import { Projects } from '@/pages/Projects';
import { ProjectChat } from '@/pages/ProjectChat';
import { AuditLog } from '@/pages/AuditLog';
import { Settings } from '@/pages/Settings';
import { Login } from '@/pages/Login';
import { Setup } from '@/pages/Setup';
import { Onboarding } from '@/pages/Onboarding';
import { AdminUsers } from '@/pages/admin/Users';
import { AdminRoles } from '@/pages/admin/Roles';
import { AdminPolicies } from '@/pages/admin/Policies';
import { useSession } from '@/lib/auth';
import { api } from '@/lib/api';

function App() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  const { user, loading, signOut, refetch: refreshSession } = useSession();
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Check setup status
  const { data: setupStatus, isLoading: setupLoading } = useQuery({
    queryKey: ['setup-status'],
    queryFn: api.getSetupStatus,
    enabled: !!user,
  });

  // Check onboarding status (only after setup is confirmed complete)
  const { data: onboardingStatus, isLoading: onboardingLoading } = useQuery({
    queryKey: ['onboarding'],
    queryFn: api.getOnboarding,
    enabled: !!user && (setupStatus?.setupCompleted !== false),
  });

  const handleSetupComplete = useCallback(() => {
    setSetupDismissed(true);
  }, []);

  const handleOnboardingComplete = useCallback(() => {
    setOnboardingDismissed(true);
  }, []);

  // Show loading state while checking session
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground text-lg font-bold animate-pulse">
            T
          </div>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // Show login page if not authenticated
  if (!user) {
    return <Login onSuccess={refreshSession} />;
  }

  // Show setup wizard if not completed (and not dismissed this session)
  if (!setupLoading && setupStatus && !setupStatus.setupCompleted && !setupDismissed) {
    return <Setup onComplete={handleSetupComplete} />;
  }

  // Show onboarding if user hasn't been onboarded (and not dismissed this session)
  if (
    !onboardingLoading &&
    onboardingStatus &&
    !onboardingStatus.onboarded &&
    !onboardingDismissed
  ) {
    return <Onboarding userName={user.name} onComplete={handleOnboardingComplete} />;
  }

  const isAdmin = user.roles?.includes('admin') ?? false;

  let page: React.ReactNode;

  // Dynamic routes with parameters
  const agentEditMatch = hash.match(/^#\/agents\/(.+)$/);
  if (agentEditMatch) {
    const id = agentEditMatch[1];
    page = id === 'new' ? <AgentEdit isNew /> : <AgentEdit agentId={id} />;
  }

  const chatThreadMatch = hash.match(/^#\/chat\/(.+)$/);
  if (chatThreadMatch) {
    page = <Chat initialThreadId={chatThreadMatch[1]} />;
  }

  const projectChatMatch = !page && hash.match(/^#\/projects\/(.+)$/);
  if (projectChatMatch) {
    page = <ProjectChat projectId={projectChatMatch[1]} />;
  }

  if (hash === '#/knowledge/add') {
    page = <KnowledgeAdd />;
  }

  const knowledgeDetailMatch = !page && hash.match(/^#\/knowledge\/(.+)$/);
  if (knowledgeDetailMatch) {
    page = <KnowledgeDetail sourceId={knowledgeDetailMatch[1]} />;
  }

  if (!page) switch (hash) {
    case '#/projects':
      page = <Projects />;
      break;
    case '#/agents':
      page = <Agents />;
      break;
    case '#/channels':
      page = <Channels />;
      break;
    case '#/connections':
      page = <Connections />;
      break;
    case '#/my-connections':
      page = <MyConnections />;
      break;
    case '#/schedules':
      page = <Schedules />;
      break;
    case '#/services':
      page = <Services />;
      break;
    case '#/knowledge':
      page = <Knowledge />;
      break;
    case '#/audit':
      page = <AuditLog isAdmin={isAdmin} />;
      break;
    case '#/settings':
      page = <Settings />;
      break;
    case '#/admin/users':
      page = <AdminUsers />;
      break;
    case '#/admin/roles':
      page = <AdminRoles />;
      break;
    case '#/admin/policies':
      page = <AdminPolicies />;
      break;
    default:
      page = <Chat />;
  }

  return <Layout user={user} onSignOut={signOut}>{page}</Layout>;
}

export default App;
