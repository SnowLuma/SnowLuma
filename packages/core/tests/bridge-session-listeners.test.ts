import { describe, expect, it, vi } from 'vitest';
import { BridgeManager } from '../src/bridge/manager';

describe('BridgeManager session subscriptions', () => {
    it('unsubscribes repeated registrations independently', async () => {
        const manager = new BridgeManager();
        const started = vi.fn();
        const closed = vi.fn();
        const offStarted = manager.addSessionStartedListener(started);
        manager.addSessionStartedListener(started);
        const offClosed = manager.addSessionClosedListener(closed);
        manager.addSessionClosedListener(closed);
        offStarted();
        offStarted();
        offClosed();
        offClosed();

        manager.onHookLogin(4001, '12345', {} as never);
        manager.onPidDisconnected(4001);
        expect(started).toHaveBeenCalledTimes(1);
        expect(closed).toHaveBeenCalledTimes(1);
        await manager.dispose();
    });

    it('keeps the current fan-out stable when a listener unsubscribes a peer', async () => {
        const manager = new BridgeManager();
        const peer = vi.fn();
        manager.addSessionStartedListener(() => offPeer());
        const offPeer = manager.addSessionStartedListener(peer);

        manager.onHookLogin(4002, '12345', {} as never);
        manager.onHookLogin(4003, '23456', {} as never);
        expect(peer).toHaveBeenCalledTimes(1);
        await manager.dispose();
    });
});
