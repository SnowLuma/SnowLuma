import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPolling } from '../src/lib/polling';

let page: EventTarget & { hidden: boolean };

beforeEach(() => {
    vi.useFakeTimers();
    page = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('document', page);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('resource polling', () => {
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
