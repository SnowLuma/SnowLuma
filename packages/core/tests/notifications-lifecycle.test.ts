import { IdentityService } from '@snowluma/protocol/identity-service';
import type { PacketSender } from '@snowluma/common/packet-sender';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeManager } from '../src/bridge/manager';
import { NotificationManager, type NotificationManagerDeps } from '../src/notifications/manager';

const sender: PacketSender = {
    sendPacket: async () => ({
        success: false,
        gotResponse: false,
        errorCode: -1,
        errorMessage: 'test: no QQ connection',
        responseData: null,
    }),
};

describe('notification lifecycle PID', () => {
    let bridges: BridgeManager;
    let notifications: NotificationManager;
    const posts: string[] = [];
    const resolveProcess = vi.fn<NonNullable<NotificationManagerDeps['resolveProcess']>>(
        async (_uin, pid) => (pid === null ? undefined : { pid }),
    );

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(IdentityService, 'openForUin').mockImplementation((uin) =>
            IdentityService.memory(uin),
        );
        posts.length = 0;
        resolveProcess.mockClear();
        bridges = new BridgeManager();
        notifications = new NotificationManager({
            loadConfig: () => ({
                version: 1,
                debounceSeconds: 30,
                channels: [
                    {
                        id: 'c1',
                        name: 'C1',
                        type: 'webhook',
                        url: 'https://hook.example/c1',
                        enabled: true,
                        bodyTemplate: '{event}:{uin}:{pid}',
                    },
                ],
            }),
            loadChannelIds: () => ['c1'],
            post: async (_url, body) => {
                posts.push(body);
                return { ok: true };
            },
            now: () => Date.now(),
            resolveProcess,
        });
        notifications.bind(bridges);
    });

    afterEach(async () => {
        notifications.dispose();
        await bridges.dispose();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('detaches from session events when disposed and cannot be rebound afterward', () => {
        const online = vi.spyOn(notifications, 'handleOnline');
        const offline = vi.spyOn(notifications, 'handleOffline');
        notifications.dispose();
        notifications.bind(bridges);

        bridges.onHookLogin(1001, '12345', sender);
        bridges.onPidDisconnected(1001);

        expect(online).not.toHaveBeenCalled();
        expect(offline).not.toHaveBeenCalled();
    });

    it('replaces its existing binding instead of delivering each event twice', () => {
        const online = vi.spyOn(notifications, 'handleOnline');
        notifications.bind(bridges);

        bridges.onHookLogin(1001, '12345', sender);

        expect(online).toHaveBeenCalledOnce();
    });

    it('retains the final detached PID through debounce and uses the new PID on recovery', async () => {
        bridges.onHookLogin(1001, '12345', sender);
        bridges.onHookLogin(2002, '12345', sender);
        bridges.onPidDisconnected(1001);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(posts).toEqual([]);

        bridges.onPidDisconnected(2002);
        expect(bridges.getBridge('12345')).toBeNull();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(resolveProcess).toHaveBeenNthCalledWith(1, '12345', 2002);

        bridges.onHookLogin(3003, '12345', sender);
        await vi.advanceTimersByTimeAsync(0);
        expect(resolveProcess).toHaveBeenNthCalledWith(2, '12345', 3003);
        expect(posts).toEqual(['offline:12345:2002', 'online:12345:3003']);
    });

    it('keeps queued event context when the same UIN recovers on another PID', async () => {
        bridges.onHookLogin(1001, '12345', sender);
        bridges.onPidDisconnected(1001);
        const offline = notifications.notify('12345', 'offline');
        bridges.onHookLogin(2002, '12345', sender);
        const online = notifications.notify('12345', 'online');
        await Promise.all([offline, online]);
        expect(resolveProcess.mock.calls).toEqual([
            ['12345', 1001],
            ['12345', 2002],
        ]);
        expect(posts).toEqual(['offline:12345:1001', 'online:12345:2002']);
    });
});
