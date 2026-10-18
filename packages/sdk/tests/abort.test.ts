import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestAbortState } from '../src/internal/abort';

afterEach(() => vi.useRealTimers());

describe('request cancellation', () => {
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
