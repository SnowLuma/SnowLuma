import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OneBotManager } from '@snowluma/onebot/manager';
import { initWebUI } from '../src/webui/server';
import { StateBus } from '../src/webui/state-bus';
import { findAvailablePort } from '../src/webui/port';

vi.mock('@hono/node-server', () => ({
    serve: vi.fn((_options: unknown, onListen: (info: { port: number }) => void) => {
        queueMicrotask(() => onListen({ port: 5099 }));
        return { close: (done: () => void) => done() };
    }),
}));

vi.mock('../src/webui/port', () => ({
    findAvailablePort: vi.fn(async () => 5099),
}));

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubEnv('SNOWLUMA_DEV_MODE', '1');
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('WebUI background tasks', () => {
    it('releases token maintenance when the server stops', async () => {
        const server = await initWebUI(5099, {} as OneBotManager);
        expect(vi.getTimerCount()).toBe(1);
        await server.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not poll connections without a client and releases maintenance on stop', async () => {
        const getConnectionStatuses = vi.fn(() => []);
        const manager = { getConnectionStatuses } as unknown as OneBotManager;
        const server = await initWebUI(5099, manager, undefined, undefined, {
            stateBus: new StateBus(),
        });

        try {
            await vi.advanceTimersByTimeAsync(60_000);
            expect(getConnectionStatuses).not.toHaveBeenCalled();
        } finally {
            await server.stop();
        }

        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not leave background tasks after startup fails', async () => {
        vi.mocked(findAvailablePort).mockRejectedValueOnce(new Error('no port'));
        await expect(
            initWebUI(5099, {} as OneBotManager, undefined, undefined, {
                stateBus: new StateBus(),
            }),
        ).rejects.toThrow('no port');
        expect(vi.getTimerCount()).toBe(0);
    });
});
