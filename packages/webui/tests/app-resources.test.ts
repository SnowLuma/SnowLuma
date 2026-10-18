import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';
import { createAppResources } from '../src/lib/app-resources';
import type { QQInfo } from '../src/types';

function setup() {
    const api = createApiClient({ tokenStore: { load: () => null, save: () => undefined } });
    vi.spyOn(api, 'qqList').mockResolvedValue([]);
    vi.spyOn(api.processes, 'list').mockResolvedValue([]);
    vi.spyOn(api, 'connections').mockResolvedValue([]);
    return { api, store: createAppResources(api) };
}

const accounts: QQInfo[] = [{ uin: '12345', nickname: '当前账号' }];

describe('app resources', () => {
    it('publishes data and load status together, distinguishing an empty result from an initial load', async () => {
        const { store } = setup();
        const initial = store.getSnapshot();
        expect(initial.qqList).toEqual({ data: [], ready: false, error: null });
        const listener = vi.fn(() => {
            expect(store.getSnapshot().qqList).toEqual({ data: [], ready: true, error: null });
        });
        const unsubscribe = store.subscribe(listener);
        await store.refreshQqList();
        expect(listener).toHaveBeenCalledOnce();
        expect(initial.qqList.ready).toBe(false);
        unsubscribe();
        await store.refreshQqList();
        expect(listener).toHaveBeenCalledOnce();
    });

    it('keeps the latest request when an older request completes later', async () => {
        const { api, store } = setup();
        const old = Promise.withResolvers<QQInfo[]>();
        vi.mocked(api.qqList).mockReturnValueOnce(old.promise).mockResolvedValueOnce(accounts);
        const first = store.refreshQqList();
        await store.refreshQqList();
        old.resolve([]);
        await first;
        expect(store.getSnapshot().qqList.data).toEqual(accounts);
    });

    it.each(['success', 'failure'])(
        'keeps a pushed snapshot after a stale REST %s',
        async (outcome) => {
            const { api, store } = setup();
            const request = Promise.withResolvers<QQInfo[]>();
            vi.mocked(api.qqList).mockReturnValueOnce(request.promise);
            const pending = store.refreshQqList();
            store.onEvent({ resource: 'qq-list', data: accounts });
            const snapshot = store.getSnapshot();

            if (outcome === 'success') {
                request.resolve([]);
            } else {
                request.reject(new Error('过期请求失败'));
            }

            await pending;
            expect(store.getSnapshot()).toBe(snapshot);
            expect(snapshot.qqList).toEqual({ data: accounts, ready: true, error: null });
        },
    );

    it('does not invalidate a different resource when receiving a push', async () => {
        const { api, store } = setup();
        vi.mocked(api.qqList).mockResolvedValueOnce(accounts);
        const pending = store.refreshQqList();
        store.onEvent({ resource: 'connections', data: [] });
        await pending;
        expect(store.getSnapshot().qqList.data).toEqual(accounts);
        expect(store.getSnapshot().connections.ready).toBe(true);
    });

    it('retains the last data on failure and clears the error on recovery', async () => {
        const { api, store } = setup();
        store.onEvent({ resource: 'qq-list', data: accounts });
        vi.mocked(api.qqList).mockRejectedValueOnce(new Error('连接中断'));
        await store.refreshQqList();
        expect(store.getSnapshot().qqList).toEqual({
            data: accounts,
            ready: true,
            error: '连接中断',
        });
        await store.refreshQqList();
        expect(store.getSnapshot().qqList).toEqual({ data: [], ready: true, error: null });
    });

    it('invalidates pending work on cleanup and allows a new subscription cycle', async () => {
        const { api, store } = setup();
        const request = Promise.withResolvers<QQInfo[]>();
        vi.mocked(api.qqList).mockReturnValueOnce(request.promise);
        const pending = store.refreshQqList();
        const initial = store.getSnapshot();
        store.invalidate();
        request.resolve(accounts);
        await pending;
        expect(store.getSnapshot()).toBe(initial);
        await store.refreshQqList();
        expect(store.getSnapshot().qqList.ready).toBe(true);
    });

    it('reconciles all stream resources when frames are dropped', async () => {
        const { api, store } = setup();
        store.onEvent({ kind: 'ready' });
        expect(api.qqList).not.toHaveBeenCalled();
        store.onEvent({ kind: 'dropped', count: 3 });
        await vi.waitFor(() => expect(store.getSnapshot().connections.ready).toBe(true));
        expect(api.qqList).toHaveBeenCalledOnce();
        expect(api.processes.list).toHaveBeenCalledOnce();
        expect(api.connections).toHaveBeenCalledOnce();
    });

    it('reports background update failures but rejects an explicit forced check', async () => {
        const { api, store } = setup();
        vi.spyOn(api.update, 'check').mockRejectedValue(new Error('检查失败'));
        await expect(store.refreshUpdate()).resolves.toBeNull();
        expect(store.getSnapshot().updateInfo.error).toBe('检查失败');
        await expect(store.refreshUpdate(true)).rejects.toThrow('检查失败');
        expect(api.update.check).toHaveBeenLastCalledWith(true);
    });
});
