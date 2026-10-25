import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setCsrfToken, setUnauthenticatedHandler, type Role, type User } from './api';

interface SessionValue {
  user: User | null;
  checking: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (role: Role) => boolean;
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setUser(null);
    });
    api
      .session()
      .then((s) => {
        setCsrfToken(s.csrfToken);
        setUser(s.user);
      })
      .catch(() => {
        setUser(null);
      })
      .finally(() => {
        setChecking(false);
      });
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const s = await api.signIn(email, password);
    setCsrfToken(s.csrfToken);
    setUser(s.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.signOut();
    } finally {
      setCsrfToken('');
      setUser(null);
    }
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      user,
      checking,
      signIn,
      signOut,
      can: (role) => user !== null && RANK[user.role] >= RANK[role],
    }),
    [user, checking, signIn, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession outside SessionProvider');
  return value;
}
