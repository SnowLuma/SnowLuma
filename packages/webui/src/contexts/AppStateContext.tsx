import { createContext, useContext, type ReactNode } from 'react';
import type { AccountConnections, HookProcessInfo, QQInfo, SystemInfo, UpdateInfo } from '@/types';
import type { HookProcessOps } from '@/hooks/use-hook-process-ops';

/**
 * Live mutable state owned by AppLayout and shared with the child route
 * components rendered inside its `<Outlet />`. Pages used to receive these
 * via prop drilling — now they pull from context so adding a new page does
 * not touch AppLayout.
 */
export interface AppStateValue {
  qqList: QQInfo[];
  processList: HookProcessInfo[];
  systemInfo: SystemInfo | null;
  connections: AccountConnections[];
  /** Advisory update-availability info; null until the first check resolves. */
  updateInfo: UpdateInfo | null;
  selectedUin: string | null;
  setSelectedUin: (uin: string | null) => void;
  processOps: HookProcessOps;
  refreshProcesses: () => void;
  refreshSystem: () => void;
  refreshConnections: () => void;
  /** Re-run the update check; `force` bypasses the server-side cache. */
  refreshUpdate: (force?: boolean) => Promise<void>;
  /** Triggered from the topbar logout button. */
  onLogout: () => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({
  value,
  children,
}: {
  value: AppStateValue;
  children: ReactNode;
}) {
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const v = useContext(AppStateContext);
  if (!v) throw new Error('useAppState must be used inside <AppStateProvider>');
  return v;
}
