import { createContext, useContext, type ReactNode } from 'react';
import type { UpdateInfo } from '@/types';
import type { AppResourceData, AppResources } from '@/lib/app-resources';
import type { HookProcessOps } from '@/hooks/use-hook-process-ops';

export interface AppStateValue extends AppResourceData {
    /** Distinguishes an empty result from an unresolved or failed initial read. */
    resources: AppResources;
    selectedUin: string | null;
    setSelectedUin: (uin: string | null) => void;
    processOps: HookProcessOps;
    refreshQqList: () => void;
    refreshProcesses: () => void;
    refreshSystem: () => void;
    refreshConnections: () => void;
    /** Re-run the update check; `force` bypasses the server-side cache. */
    refreshUpdate: (force?: boolean) => Promise<UpdateInfo | null>;
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

    if (!v) {
        throw new Error('useAppState must be used inside <AppStateProvider>');
    }

    return v;
}
