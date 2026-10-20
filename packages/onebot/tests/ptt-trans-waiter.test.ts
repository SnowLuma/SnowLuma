import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    deliverPttTransText,
    pttTransKey,
    requestPttTransText,
} from '../src/modules/ptt-trans-waiter';

afterEach(() => vi.useRealTimers());

describe('PTT transcription requests', () => {
    it.each([Number(18446744073335783674n), 1.5, NaN, Infinity])(
        'rejects an inexact numeric message id: %s',
        (msgId) => {
            expect(() => pttTransKey(10001, msgId)).toThrow(RangeError);
        },
    );

    it('keeps accounts isolated for the same message id', async () => {
        const first = requestPttTransText(pttTransKey(10001, 1), 20_000, async () => '');
        const second = requestPttTransText(pttTransKey(10002, 1), 20_000, async () => '');
        deliverPttTransText(pttTransKey(10001, 1), 'first');
        deliverPttTransText(pttTransKey(10002, 1), 'second');
        await expect(first).resolves.toBe('first');
        await expect(second).resolves.toBe('second');
    });

    it.each(['text', ''])('accepts a pushed transcription: %j', async (text) => {
        const result = requestPttTransText('account:push', 20_000, async () => '');
        expect(deliverPttTransText('account:push', text)).toBe(true);
        await expect(result).resolves.toBe(text);
        expect(deliverPttTransText('account:push', text)).toBe(false);
    });

    it('registers before triggering so an immediate push is not lost', async () => {
        const result = requestPttTransText('account:fast', 20_000, async () => {
            deliverPttTransText('account:fast', 'pushed');
            return 'inline';
        });
        await expect(result).resolves.toBe('pushed');
    });

    it('accepts an inline transcription', async () => {
        await expect(
            requestPttTransText('account:inline', 20_000, async () => 'inline'),
        ).resolves.toBe('inline');
    });

    it.each([new Error('failed'), 'failed'])(
        'propagates a trigger failure: %s',
        async (failure) => {
            await expect(
                requestPttTransText('account:failure', 20_000, async () => {
                    throw failure;
                }),
            ).rejects.toThrow('failed');
        },
    );

    it('handles a synchronous trigger failure', async () => {
        await expect(
            requestPttTransText('account:sync-failure', 20_000, () => {
                throw new Error('sync');
            }),
        ).rejects.toThrow('sync');
    });

    it.each(['resolve', 'reject'] as const)(
        'ignores a superseded trigger that later calls %s',
        async (settle) => {
            const oldTrigger = Promise.withResolvers<string>();
            const old = requestPttTransText('account:replace', 20_000, () => oldTrigger.promise);
            const rejected = expect(old).rejects.toThrow('被新的请求取代');
            const current = requestPttTransText('account:replace', 20_000, async () => '');
            await rejected;

            if (settle === 'resolve') {
                oldTrigger.resolve('stale');
            } else {
                oldTrigger.reject(new Error('stale'));
            }

            await new Promise((resolve) => setTimeout(resolve, 0));
            deliverPttTransText('account:replace', 'current');
            await expect(current).resolves.toBe('current');
        },
    );

    it('times out while the trigger is pending and ignores its eventual failure', async () => {
        vi.useFakeTimers();
        const trigger = Promise.withResolvers<string>();
        const result = requestPttTransText('account:timeout', 1_000, () => trigger.promise);
        const rejected = expect(result).rejects.toThrow('超时');
        await vi.advanceTimersByTimeAsync(1_000);
        await rejected;
        const next = requestPttTransText('account:timeout', 1_000, async () => '');
        trigger.reject(new Error('late failure'));
        await vi.advanceTimersByTimeAsync(0);
        deliverPttTransText('account:timeout', 'next');
        await expect(next).resolves.toBe('next');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the timeout after a successful result', async () => {
        vi.useFakeTimers();
        const result = requestPttTransText('account:done', 1_000, async () => 'done');
        await expect(result).resolves.toBe('done');
        expect(vi.getTimerCount()).toBe(0);
        expect(() => deliverPttTransText('account:done', 'late')).not.toThrow();
    });
});
