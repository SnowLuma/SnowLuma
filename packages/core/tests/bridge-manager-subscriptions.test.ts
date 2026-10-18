import { IdentityService } from '@snowluma/protocol/identity-service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeManager } from '../src/bridge/manager';

describe('BridgeManager subscriptions', () => {
    let manager: BridgeManager;
    const sender = { sendPacket: vi.fn() } as never;

    beforeEach(() => {
        vi.spyOn(IdentityService, 'openForUin').mockImplementation((uin) =>
            IdentityService.memory(uin),
        );
        manager = new BridgeManager();
    });

    afterEach(async () => {
        await manager.dispose();
        vi.restoreAllMocks();
    });

    it('unsubscribes both session edges without removing another observer', () => {
        const started = vi.fn();
        const closed = vi.fn();
        const peer = { started: vi.fn(), closed: vi.fn() };
        const unsubscribe = manager.subscribeSessions({ started, closed });
        manager.subscribeSessions(peer);

        manager.onHookLogin(101, '10001', sender);
        unsubscribe();
        manager.onPidDisconnected(101);
        manager.onHookLogin(202, '20002', sender);

        expect(started).toHaveBeenCalledOnce();
        expect(closed).not.toHaveBeenCalled();
        expect(peer.started).toHaveBeenCalledTimes(2);
        expect(peer.closed).toHaveBeenCalledOnce();
    });

    it('keeps subscription handles independent when an observer is reused', () => {
        const listener = { started: vi.fn(), closed: vi.fn() };
        const unsubscribeFirst = manager.subscribeSessions(listener);
        const unsubscribeSecond = manager.subscribeSessions(listener);
        unsubscribeFirst();
        unsubscribeFirst();

        manager.onHookLogin(101, '10001', sender);
        expect(listener.started).toHaveBeenCalledOnce();
        manager.onPidDisconnected(101);
        expect(listener.closed).toHaveBeenCalledOnce();
        unsubscribeSecond();
        manager.onHookLogin(202, '20002', sender);
        manager.onPidDisconnected(202);
        expect(listener.started).toHaveBeenCalledOnce();
        expect(listener.closed).toHaveBeenCalledOnce();
    });

    it('applies listener changes to the next event while preserving dispatch order', () => {
        const seen: string[] = [];
        let unsubscribeSecond: () => void;
        manager.subscribeSessions({
            started: () => {
                seen.push('first');
                unsubscribeSecond();
                manager.subscribeSessions({ started: () => seen.push('later') });
            },
        });
        unsubscribeSecond = manager.subscribeSessions({ started: () => seen.push('second') });

        manager.onHookLogin(101, '10001', sender);
        expect(seen).toEqual(['first', 'second']);
        seen.length = 0;
        manager.onHookLogin(202, '20002', sender);
        expect(seen).toEqual(['first', 'later']);
    });

    it('releases its observers when disposed', async () => {
        const started = vi.fn();
        manager.subscribeSessions({ started });
        await manager.dispose();

        manager.onHookLogin(101, '10001', sender);
        expect(started).not.toHaveBeenCalled();
    });
});
