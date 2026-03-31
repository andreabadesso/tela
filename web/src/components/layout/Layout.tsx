import { useState, useEffect } from 'react';
import {
  MessageSquare,
  Bot,
  Link2,
  Plug,
  Clock,
  BookOpen,
  ScrollText,
  Settings,
  Menu,
  X,
  LogOut,
  Users,
  ShieldCheck,
  UserCog,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface NavItem {
  icon: React.ReactNode;
  label: string;
  hash: string;
  active?: boolean;
  comingSoon?: boolean;
}

const navItems: NavItem[] = [
  { icon: <MessageSquare className="h-4 w-4" />, label: 'Chat', hash: '#/' },
  { icon: <Bot className="h-4 w-4" />, label: 'Agents', hash: '#/agents' },
  { icon: <Plug className="h-4 w-4" />, label: 'My Connections', hash: '#/my-connections' },
  { icon: <Link2 className="h-4 w-4" />, label: 'Connections', hash: '#/connections' },
  { icon: <Clock className="h-4 w-4" />, label: 'Schedules', hash: '#/schedules' },
  { icon: <BookOpen className="h-4 w-4" />, label: 'Knowledge', hash: '#/knowledge' },
  { icon: <ScrollText className="h-4 w-4" />, label: 'Audit Log', hash: '#/audit' },
  { icon: <Settings className="h-4 w-4" />, label: 'Settings', hash: '#/settings' },
];

const adminNavItems: NavItem[] = [
  { icon: <Users className="h-4 w-4" />, label: 'Users', hash: '#/admin/users' },
  { icon: <UserCog className="h-4 w-4" />, label: 'Roles & Teams', hash: '#/admin/roles' },
  { icon: <ShieldCheck className="h-4 w-4" />, label: 'Policies', hash: '#/admin/policies' },
];

interface LayoutUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  roles?: string[];
}

export function Layout({ children, user, onSignOut }: { children: React.ReactNode; user?: LayoutUser; onSignOut?: () => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currentHash, setCurrentHash] = useState(window.location.hash || '#/');
  const isAdmin = user?.roles?.includes('admin') ?? false;

  useEffect(() => {
    const onHashChange = () => setCurrentHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-border bg-card transition-transform duration-200 lg:relative lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Logo */}
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
              T
            </div>
            <span className="text-lg font-semibold tracking-tight">Tela</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden h-8 w-8"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <Separator />

        {/* Navigation */}
        <nav className="flex-1 space-y-1 px-2 py-3 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = currentHash === item.hash || (item.hash === '#/' && currentHash === '');
            return (
              <a
                key={item.hash}
                href={item.comingSoon ? undefined : item.hash}
                onClick={(e) => {
                  if (item.comingSoon) {
                    e.preventDefault();
                    return;
                  }
                  setSidebarOpen(false);
                }}
                title={item.comingSoon ? 'Coming Soon' : item.label}
                className={cn(
                  'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  item.comingSoon && 'cursor-not-allowed opacity-50'
                )}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.comingSoon && (
                  <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground/60">
                    Soon
                  </span>
                )}
              </a>
            );
          })}

          {/* Admin section — only visible to users with admin role */}
          {isAdmin && (
            <>
              <Separator className="my-2" />
              <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                Admin
              </p>
              {adminNavItems.map((item) => {
                const isActive = currentHash === item.hash;
                return (
                  <a
                    key={item.hash}
                    href={item.hash}
                    onClick={() => setSidebarOpen(false)}
                    title={item.label}
                    className={cn(
                      'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    )}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </a>
                );
              })}
            </>
          )}
        </nav>

        {/* Footer */}
        <div className="border-t border-border px-4 py-3">
          {user ? (
            <div className="flex items-center gap-2">
              {user.image ? (
                <img
                  src={user.image}
                  alt={user.name}
                  className="h-7 w-7 rounded-full"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {user.name?.charAt(0)?.toUpperCase() || '?'}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{user.name}</p>
                <p className="text-[10px] text-muted-foreground truncate">{user.email}</p>
              </div>
              {onSignOut && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={onSignOut}
                  title="Sign out"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Tela v0.1.0</p>
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile header */}
        <header className="flex h-14 items-center gap-3 border-b border-border px-4 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-4 w-4" />
          </Button>
          <span className="text-sm font-semibold">Tela</span>
        </header>

        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
