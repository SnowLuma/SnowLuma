import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContactList } from '../src/lib/debug-contacts';
import type { DebugInvokeResult } from '../src/types';

function deferred() {
    let resolve!: (result: DebugInvokeResult) => void;
    const promise = new Promise<DebugInvokeResult>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const success = (nickname: string): DebugInvokeResult => ({
    status: 'ok',
    data: [{ user_id: 123, nickname }],
});

beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe('debug contact lists', () => {
    it('keeps account state separate and ignores a response after leaving its list', async () => {
        const previous = deferred();
        const invoke = vi
            .fn()
            .mockReturnValueOnce(previous.promise)
            .mockResolvedValue(success('current'));
        const oldList = createContactList(invoke, 'friends', 'old-account');
        const pending = oldList.refresh();
        oldList.invalidate();
        const current = createContactList(invoke, 'friends', 'new-account');
        await current.refresh();
        previous.resolve(success('stale'));
        await pending;
        expect(current.getSnapshot().items[0].label).toBe('current');
        expect(oldList.getSnapshot().items).toEqual([]);
        expect(createContactList(invoke, 'friends', 'old-account').getSnapshot().items).toEqual([]);
    });

    it('supersedes an in-flight refresh when using a fresh cached list', async () => {
        const pending = deferred();
        const invoke = vi
            .fn()
            .mockResolvedValueOnce(success('cached'))
            .mockReturnValueOnce(pending.promise);
        const list = createContactList(invoke, 'friends', 'cache-account');
        await list.refresh();
        const refresh = list.refresh();
        await list.refresh(false);
        expect(list.getSnapshot().loading).toBe(false);
        pending.resolve(success('superseded'));
        await refresh;
        expect(list.getSnapshot().items[0].label).toBe('cached');
    });

    it('ignores an earlier refresh that completes after its replacement', async () => {
        const first = deferred();
        const invoke = vi
            .fn()
            .mockReturnValueOnce(first.promise)
            .mockResolvedValueOnce(success('latest'));
        const list = createContactList(invoke, 'friends', 'race-account');
        const pending = list.refresh();
        await list.refresh();
        first.resolve(success('old'));
        await pending;
        expect(list.getSnapshot().items[0].label).toBe('latest');
    });

    it('keeps group-member caches scoped to the account and group', async () => {
        const invoke = vi.fn().mockResolvedValue(success('member'));
        const first = createContactList(invoke, 'members', 'member-account', '111');
        await first.refresh();
        expect(invoke).toHaveBeenCalledWith('member-account', 'get_group_member_list', {
            group_id: '111',
        });
        expect(
            createContactList(invoke, 'members', 'member-account', '111').getSnapshot().items,
        ).toHaveLength(1);
        expect(
            createContactList(invoke, 'members', 'member-account', '222').getSnapshot().items,
        ).toEqual([]);
        expect(
            createContactList(invoke, 'members', 'other-account', '111').getSnapshot().items,
        ).toEqual([]);
    });

    it('reports malformed successful responses instead of caching an empty list', async () => {
        const invoke = vi
            .fn()
            .mockResolvedValueOnce(success('retained'))
            .mockResolvedValueOnce({ status: 'ok', data: {} });
        const list = createContactList(invoke, 'friends', 'invalid-account');
        await list.refresh();
        await list.refresh();
        expect(list.getSnapshot()).toMatchObject({ loading: false, error: '联系人列表格式无效' });
        expect(list.getSnapshot().items[0].label).toBe('retained');
        await list.refresh(false);
        expect(list.getSnapshot().error).toBeNull();
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('does not request contacts without an account or group selection', async () => {
        const invoke = vi.fn();
        const lists = [
            createContactList(invoke, 'friends', ''),
            createContactList(invoke, 'members', 'account'),
        ];

        for (const list of lists) {
            await list.refresh();
            expect(list.getSnapshot()).toEqual({ items: [], loading: false, error: null });
        }

        expect(invoke).not.toHaveBeenCalled();
    });
});
