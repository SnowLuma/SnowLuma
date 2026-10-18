import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApi } from '@/lib/api';
import { createAppResources } from '@/lib/app-resources';
import { startPolling } from '@/lib/polling';

export function useAppResources(pollInterval: number) {
    const api = useApi();
    const store = useMemo(() => createAppResources(api), [api]);
    const resources = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

    useEffect(() => {
        const dispose = api.stateStream({ onEvent: store.onEvent });

        return () => {
            dispose();
            store.invalidate();
        };
    }, [api, store]);

    // Reconcile SSE resources periodically; system metrics keep the faster cadence.
    useEffect(
        () =>
            startPolling(
                store.reconcile,
                pollInterval > 0 ? Math.max(pollInterval * 10, 10_000) : 0,
            ),
        [pollInterval, store],
    );
    useEffect(() => startPolling(store.refreshSystem, pollInterval), [pollInterval, store]);
    useEffect(() => startPolling(store.refreshUpdate, 6 * 60 * 60 * 1000, false), [store]);

    return {
        qqList: resources.qqList.data,
        processList: resources.processList.data,
        systemInfo: resources.systemInfo.data,
        connections: resources.connections.data,
        updateInfo: resources.updateInfo.data,
        resources,
        refreshQqList: store.refreshQqList,
        refreshProcesses: store.refreshProcesses,
        refreshSystem: store.refreshSystem,
        refreshConnections: store.refreshConnections,
        refreshUpdate: store.refreshUpdate,
    };
}
