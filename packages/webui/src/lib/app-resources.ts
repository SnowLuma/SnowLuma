import type { ApiClient, StateStreamEvent } from '@/lib/api/types';
import type { AccountConnections, HookProcessInfo, QQInfo, SystemInfo, UpdateInfo } from '@/types';

export interface AppResourceData {
    qqList: QQInfo[];
    processList: HookProcessInfo[];
    systemInfo: SystemInfo | null;
    connections: AccountConnections[];
    updateInfo: UpdateInfo | null;
}

export type AppResources = {
    [K in keyof AppResourceData]: {
        data: AppResourceData[K];
        ready: boolean;
        error: string | null;
    };
};

type ResourceKey = keyof AppResourceData;

const LOAD_ERRORS: Record<ResourceKey, string> = {
    qqList: '加载账号列表失败',
    processList: '加载进程列表失败',
    systemInfo: '加载系统信息失败',
    connections: '加载连接状态失败',
    updateInfo: '检查更新失败',
};

export function createAppResources(api: ApiClient) {
    let snapshot: AppResources = {
        qqList: { data: [], ready: false, error: null },
        processList: { data: [], ready: false, error: null },
        systemInfo: { data: null, ready: false, error: null },
        connections: { data: [], ready: false, error: null },
        updateInfo: { data: null, ready: false, error: null },
    };
    const revisions: Record<ResourceKey, number> = {
        qqList: 0,
        processList: 0,
        systemInfo: 0,
        connections: 0,
        updateInfo: 0,
    };
    const listeners = new Set<() => void>();

    function settle<K extends ResourceKey>(
        key: K,
        data: AppResourceData[K],
        error: string | null = null,
    ) {
        snapshot = { ...snapshot, [key]: { data, ready: true, error } };
        listeners.forEach((listener) => listener());
    }

    async function refresh<K extends ResourceKey>(
        key: K,
        load: () => Promise<AppResourceData[K]>,
        throwOnError = false,
    ): Promise<AppResourceData[K] | null> {
        const revision = ++revisions[key];

        try {
            const data = await load();

            if (revisions[key] !== revision) {
                return null;
            }

            settle(key, data);
            return data;
        } catch (error) {
            if (revisions[key] !== revision) {
                return null;
            }

            const message =
                error instanceof Error && error.message ? error.message : LOAD_ERRORS[key];
            settle(key, snapshot[key].data, message);

            if (throwOnError) {
                throw error;
            }

            return null;
        }
    }

    function publish<K extends ResourceKey>(key: K, data: AppResourceData[K]) {
        // A pushed snapshot supersedes any pending REST response for this resource.
        revisions[key] += 1;
        settle(key, data);
    }

    const refreshQqList = async () => {
        await refresh('qqList', () => api.qqList());
    };

    const refreshProcesses = async () => {
        await refresh('processList', () => api.processes.list());
    };

    const refreshSystem = async () => {
        await refresh('systemInfo', () => api.system());
    };

    const refreshConnections = async () => {
        await refresh('connections', () => api.connections());
    };

    const refreshUpdate = (force = false) =>
        refresh('updateInfo', () => api.update.check(force), force);

    const reconcile = async () => {
        await Promise.all([refreshQqList(), refreshProcesses(), refreshConnections()]);
    };

    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
        invalidate: () => {
            for (const key of Object.keys(revisions) as ResourceKey[]) {
                revisions[key] += 1;
            }
        },
        onEvent: (event: StateStreamEvent) => {
            if ('resource' in event) {
                switch (event.resource) {
                    case 'qq-list':
                        publish('qqList', event.data);
                        break;
                    case 'processes':
                        publish('processList', event.data);
                        break;
                    case 'connections':
                        publish('connections', event.data);
                        break;
                }
            } else if (event.kind === 'dropped') {
                void reconcile();
            }
        },
        reconcile,
        refreshQqList,
        refreshProcesses,
        refreshSystem,
        refreshConnections,
        refreshUpdate,
    };
}
