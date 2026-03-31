import { useState, useEffect, useCallback } from 'react';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  roles?: string[];
}

export interface SessionData {
  user: SessionUser;
  session: {
    id: string;
    token: string;
    expiresAt: string;
  };
}

export interface UseSessionResult {
  user: SessionUser | null;
  loading: boolean;
  error: string | null;
  signOut: () => Promise<void>;
  refetch: () => void;
}

export function useSession(): UseSessionResult {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSession = useCallback(async () => {
    try {
      setLoading(true);

      // 1. Try better-auth session
      const res = await fetch('/api/auth/get-session', {
        credentials: 'include',
      });

      if (res.ok) {
        const data: SessionData = await res.json();
        if (data?.user) {
          setUser(data.user);
          setError(null);
          return;
        }
      }

      // 2. Fallback: check /api/auth/me (uses API middleware — works in dev mode)
      const meRes = await fetch('/api/auth/me', {
        credentials: 'include',
      });

      if (meRes.ok) {
        const meData = await meRes.json();
        if (meData?.id) {
          setUser({
            id: meData.id,
            email: meData.email,
            name: meData.name ?? 'Developer',
            image: meData.image ?? null,
            roles: meData.roles,
          });
          setError(null);
          return;
        }
      }

      setUser(null);
      setError(null);
    } catch (err) {
      setUser(null);
      setError(err instanceof Error ? err.message : 'Failed to fetch session');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'include',
      });
      setUser(null);
    } catch {
      // Force logout on client side even if server fails
      setUser(null);
    }
  }, []);

  return { user, loading, error, signOut, refetch: fetchSession };
}
