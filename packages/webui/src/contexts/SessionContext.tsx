import { createContext, useContext, type ReactNode } from 'react';

/**
 * Auth-level state surfaced into the router subtree. `AuthBoundary` mints
 * this and `AppLayout` consumes it — used to drive the status badge and to
 * complete logout after page-local state has been cleared.
 */
export interface SessionValue {
  status: string;
  /** Invoked by AppLayout's logout handler after it has scrubbed its own state. */
  onLogoutComplete: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({
  value,
  children,
}: {
  value: SessionValue;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside <SessionProvider>');
  return v;
}
