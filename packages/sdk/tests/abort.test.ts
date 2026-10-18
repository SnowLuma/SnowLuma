import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestAbortState, raceWithAbort } from '../src/internal/abort';

afterEach(() => vi.useRealTimers());

describe('request cancellation', () => {
    it('honors an existing cancellation before a completed operation', async () => {
        const controller = new AbortController();
        controller.abort('already canceled');
        await expect(
            raceWithAbort(Promise.resolve('done'), controller.signal),
        ).rejects.toMatchObject({
            cause: 'already canceled',
        });
    });

    it('releases its listener when cancellation wins against a pending operation', async () => {
        const operation = Promise.withResolvers<void>();
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const result = raceWithAbort(operation.promise, controller.signal);
        controller.abort('canceled');
        await expect(result).rejects.toMatchObject({ cause: 'canceled' });
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        operation.resolve();
    });

    it.each(['resolve', 'reject'] as const)(
        'releases its listener when the operation will %s',
        async (outcome) => {
            const operation = Promise.withResolvers<string>();
            const controller = new AbortController();
            const remove = vi.spyOn(controller.signal, 'removeEventListener');
            const result = raceWithAbort(operation.promise, controller.signal);

            if (outcome === 'resolve') {
                operation.resolve('done');
                await expect(result).resolves.toBe('done');
            } else {
                operation.reject(new Error('failed'));
                await expect(result).rejects.toThrow('failed');
            }

            expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        },
    );

    it('keeps caller cancellation as the cause when the timeout expires later', () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const request = createRequestAbortState(100, caller.signal);
        caller.abort('caller canceled');
        vi.advanceTimersByTime(100);
        expect(request.signal.reason).toBe('caller canceled');
        expect(request.isExternallyAborted()).toBe(true);
        expect(request.isTimedOut()).toBe(false);
        request.cleanup();
    });

    it('keeps the timeout as the cause when the caller cancels later', () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const request = createRequestAbortState(100, caller.signal);
        vi.advanceTimersByTime(100);
        caller.abort();
        expect(request.isTimedOut()).toBe(true);
        expect(request.isExternallyAborted()).toBe(false);
        request.cleanup();
    });

    it('stops observing timeouts and caller cancellation after cleanup', () => {
        vi.useFakeTimers();
        const caller = new AbortController();
        const request = createRequestAbortState(100, caller.signal);
        request.cleanup();
        caller.abort();
        vi.advanceTimersByTime(100);
        expect(request.signal.aborted).toBe(false);
        expect(request.isTimedOut()).toBe(false);
        expect(request.isExternallyAborted()).toBe(false);
    });
});
