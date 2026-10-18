import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPolling } from '../src/lib/polling';

let page: EventTarget & { hidden: boolean };

beforeEach(() => {
    vi.useFakeTimers();
    page = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('document', page);
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('resource polling', () => {
    it('reports a failed refresh and retries without leaving a second timer', async () => {
        const failure = new Error('refresh failed');
        const report = vi.spyOn(console, 'error').mockImplementation(() => {});
        const refresh = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
        const stop = startPolling(refresh, 1000);
        await vi.advanceTimersByTimeAsync(0);
        expect(report).toHaveBeenCalledExactlyOnceWith('polling failed', failure);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);
        stop();
    });

    it('does not keep a timer while hidden or waiting for a response', async () => {
        page.hidden = true;
        const pending = Promise.withResolvers<void>();
        const refresh = vi.fn(() => pending.promise);
        const stop = startPolling(refresh, 1000);
        expect(vi.getTimerCount()).toBe(0);
        page.hidden = false;
        page.dispatchEvent(new Event('visibilitychange'));
        expect(refresh).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        pending.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
        page.hidden = true;
        page.dispatchEvent(new Event('visibilitychange'));
        expect(vi.getTimerCount()).toBe(0);
        stop();
    });

    it('does not reschedule a request that finishes after disposal', async () => {
        const pending = Promise.withResolvers<void>();
        const refresh = vi.fn(() => pending.promise);
        const stop = startPolling(refresh, 1000);
        stop();
        pending.resolve();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(refresh).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('waits a full interval after a slow response before polling again', async () => {
        const pending = Promise.withResolvers<void>();
        const refresh = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
        const stop = startPolling(refresh, 1000);
        await vi.advanceTimersByTimeAsync(1500);
        pending.resolve();
        await vi.advanceTimersByTimeAsync(999);
        expect(refresh).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(2);
        stop();
    });

    it('starts immediately and skips ticks while a request is pending', async () => {
        const pending = Promise.withResolvers<void>();
        const refresh = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
        const stop = startPolling(refresh, 1000);
        expect(refresh).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(3000);
        expect(refresh).toHaveBeenCalledOnce();
        pending.resolve();
        await vi.advanceTimersByTimeAsync(1000);
        expect(refresh).toHaveBeenCalledTimes(2);
        stop();
    });

    it('pauses in the background and refreshes when the page becomes visible', async () => {
        page.hidden = true;
        const refresh = vi.fn().mockResolvedValue(undefined);
        const stop = startPolling(refresh, 1000);
        await vi.advanceTimersByTimeAsync(2000);
        expect(refresh).not.toHaveBeenCalled();
        page.hidden = false;
        page.dispatchEvent(new Event('visibilitychange'));
        expect(refresh).toHaveBeenCalledOnce();
        stop();
        await vi.advanceTimersByTimeAsync(2000);
        page.dispatchEvent(new Event('visibilitychange'));
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('keeps initial and visibility refreshes when periodic polling is disabled', async () => {
        const refresh = vi.fn().mockResolvedValue(undefined);
        const stop = startPolling(refresh, 0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(refresh).toHaveBeenCalledOnce();
        page.dispatchEvent(new Event('visibilitychange'));
        expect(refresh).toHaveBeenCalledTimes(2);
        stop();
    });

    it('keeps the update-check cadence independent of page visibility', async () => {
        page.hidden = true;
        const refresh = vi.fn().mockResolvedValue(undefined);
        const stop = startPolling(refresh, 6000, false);
        await vi.advanceTimersByTimeAsync(6000);
        expect(refresh).toHaveBeenCalledTimes(2);
        page.hidden = false;
        page.dispatchEvent(new Event('visibilitychange'));
        expect(refresh).toHaveBeenCalledTimes(2);
        stop();
    });
});
