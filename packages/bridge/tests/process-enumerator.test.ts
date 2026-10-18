import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProcessEnumerator } from '../src/process-enumerator';
import type { HookProcessBaseInfo } from '../src/injector';

const QQ = (pid: number): HookProcessBaseInfo => ({ pid, name: 'qq', path: '' });

function deferred() {
    let resolve!: (processes: HookProcessBaseInfo[]) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<HookProcessBaseInfo[]>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('process enumeration', () => {
    it('shares one native request between concurrent callers', async () => {
        const request = deferred();
        const listProcesses = vi.fn(() => request.promise);
        const enumerator = createProcessEnumerator({ listProcesses });
        const first = enumerator.enumerate();
        expect(enumerator.enumerate()).toBe(first);
        request.resolve([QQ(1), QQ(2)]);
        expect(await first).toEqual([QQ(1), QQ(2)]);
        expect(listProcesses).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        enumerator.dispose();
    });

    it('keeps timed-out native work in flight until it actually finishes', async () => {
        const request = deferred();
        const listProcesses = vi.fn(() => request.promise).mockResolvedValueOnce([QQ(1)]);
        const enumerator = createProcessEnumerator({ listProcesses, timeoutMs: 100 });
        expect(await enumerator.enumerate()).toEqual([QQ(1)]);
        const stalled = enumerator.enumerate();
        await vi.advanceTimersByTimeAsync(100);
        expect(await stalled).toBeNull();

        for (let i = 0; i < 10; i++) {
            expect(await enumerator.enumerate()).toBeNull();
        }

        expect(listProcesses).toHaveBeenCalledTimes(2);
        request.resolve([QQ(2)]);
        await vi.advanceTimersByTimeAsync(0);
        listProcesses.mockResolvedValueOnce([QQ(3)]);
        expect(await enumerator.enumerate()).toEqual([QQ(3)]);
        expect(await stalled).toBeNull();
        enumerator.dispose();
    });

    it.each(['throw', 'reject'] as const)(
        'keeps a %s unknown and allows a fresh request',
        async (kind) => {
            const listProcesses = vi.fn<() => Promise<HookProcessBaseInfo[]>>(() => {
                if (kind === 'throw') {
                    throw new Error('process table unavailable');
                }

                return Promise.reject(new Error('process table unavailable'));
            });
            const enumerator = createProcessEnumerator({ listProcesses });
            expect(await enumerator.enumerate()).toBeNull();
            expect(vi.getTimerCount()).toBe(0);
            listProcesses.mockResolvedValueOnce([]);
            expect(await enumerator.enumerate()).toEqual([]);
            enumerator.dispose();
        },
    );

    it('handles a rejection after timeout and recovers on the next poll', async () => {
        const request = deferred();
        const listProcesses = vi.fn(() => request.promise);
        const enumerator = createProcessEnumerator({ listProcesses, timeoutMs: 100 });
        const pending = enumerator.enumerate();
        await vi.advanceTimersByTimeAsync(100);
        expect(await pending).toBeNull();
        request.reject(new Error('late failure'));
        await vi.advanceTimersByTimeAsync(0);
        listProcesses.mockResolvedValueOnce([QQ(4)]);
        expect(await enumerator.enumerate()).toEqual([QQ(4)]);
        enumerator.dispose();
    });

    it('settles disposal immediately without accepting late native results', async () => {
        const request = deferred();
        const listProcesses = vi.fn(() => request.promise);
        const enumerator = createProcessEnumerator({ listProcesses });
        const pending = enumerator.enumerate();
        await Promise.resolve();
        enumerator.dispose();
        enumerator.dispose();
        expect(await pending).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        request.resolve([QQ(1)]);
        expect(await enumerator.enumerate()).toBeNull();
        expect(listProcesses).toHaveBeenCalledTimes(1);
    });

    it('never calls the lister after disposal', async () => {
        const listProcesses = vi.fn(async () => [QQ(1)]);
        const enumerator = createProcessEnumerator({ listProcesses });
        enumerator.dispose();
        expect(await enumerator.enumerate()).toBeNull();
        expect(listProcesses).not.toHaveBeenCalled();
    });

    it('does not start queued native work when disposed in the same tick', async () => {
        const listProcesses = vi.fn(async () => [QQ(1)]);
        const enumerator = createProcessEnumerator({ listProcesses });
        const pending = enumerator.enumerate();
        enumerator.dispose();
        expect(await pending).toBeNull();
        expect(listProcesses).not.toHaveBeenCalled();
    });
});
