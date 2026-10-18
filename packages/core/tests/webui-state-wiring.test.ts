import { describe, expect, it, vi } from 'vitest';
import { StateBus } from '../src/webui/state-bus';
import { createStateWiring } from '../src/webui/state-wiring';
import { BridgeManager } from '../src/bridge/manager';

describe('createStateWiring', () => {
    it('keeps a replacement wiring independent of its disposed predecessor', async () => {
        const old = new BridgeManager();
        const current = new BridgeManager();
        const listener = vi.fn();
        const previousWiring = createStateWiring(old);
        previousWiring.bus.subscribe(listener);
        previousWiring.dispose();
        const wiring = createStateWiring(current);
        wiring.bus.subscribe(listener);

        old.onHookLogin(4100, '12345', {} as never);
        expect(listener).not.toHaveBeenCalled();
        current.onHookLogin(4200, '23456', {} as never);
        expect(listener.mock.calls).toEqual([['qq-list'], ['connections']]);

        wiring.dispose();
        await old.dispose();
        await current.dispose();
    });

    it('unsubscribes on disposal before another account starts', async () => {
        const bm = new BridgeManager();
        const subscribe = vi.spyOn(bm, 'subscribeSessions');
        const wiring = createStateWiring(bm);
        const publish = vi.spyOn(wiring.bus, 'publish');
        wiring.dispose();
        wiring.dispose();

        bm.onHookLogin(4300, '34567', {} as never);
        expect(publish).not.toHaveBeenCalled();
        expect(subscribe).toHaveBeenCalledTimes(1);
        await bm.dispose();
    });

    it('releases its session subscription when disposed', () => {
        const unsubscribe = vi.fn();
        const source = { subscribeSessions: vi.fn(() => unsubscribe) };
        const wiring = createStateWiring(source);

        wiring.dispose();

        expect(source.subscribeSessions).toHaveBeenCalledOnce();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('provides a fresh StateBus and an onSessionsChanged that publishes "processes"', () => {
        const wiring = createStateWiring(new BridgeManager());
        expect(wiring.bus).toBeInstanceOf(StateBus);
        const sub = vi.fn();
        wiring.bus.subscribe(sub);
        wiring.onSessionsChanged();
        expect(sub).toHaveBeenCalledExactlyOnceWith('processes');
    });

    it('binds a BridgeManager so session-started publishes both "qq-list" and "connections"', () => {
        const bm = new BridgeManager();
        const wiring = createStateWiring(bm);
        const seen: string[] = [];
        wiring.bus.subscribe((r) => seen.push(r));

        // Real onHookLogin path — fires the session-started listener internally
        // exactly once (per uin).
        bm.onHookLogin(4242, '12345', {} as never);
        expect(seen).toEqual(['qq-list', 'connections']);
    });

    it('publishes "qq-list" + "connections" on session-closed', () => {
        const bm = new BridgeManager();
        const wiring = createStateWiring(bm);
        bm.onHookLogin(4242, '12345', {} as never);
        const sub = vi.fn();
        wiring.bus.subscribe(sub);

        bm.onPidDisconnected(4242);

        // Order is qq-list first (account list shrinks) then connections
        // (adapter status list shrinks). Two distinct resource invalidations.
        expect(sub).toHaveBeenCalledTimes(2);
        expect(sub).toHaveBeenNthCalledWith(1, 'qq-list');
        expect(sub).toHaveBeenNthCalledWith(2, 'connections');
    });

    it('dispose() latches so later Hook/Bridge edges publish nothing', () => {
        const bm = new BridgeManager();
        const wiring = createStateWiring(bm);
        const sub = vi.fn();
        wiring.bus.subscribe(sub);

        wiring.dispose();

        // onSessionsChanged becomes a no-op.
        wiring.onSessionsChanged();
        expect(sub).not.toHaveBeenCalled();

        // BridgeManager listener fires nothing into a disposed bus.
        bm.onHookLogin(4242, '12345', {} as never);
        expect(sub).not.toHaveBeenCalled();
    });

    it('survives a BridgeManager listener throw — the OTHER listeners on the same BridgeManager keep working', () => {
        const bm = new BridgeManager();
        const wiring = createStateWiring(bm);

        // A peer subscriber (e.g. OneBotManager) added AFTER state-wiring throws.
        const peer = vi.fn(() => {
            throw new Error('peer down');
        });
        bm.subscribeSessions({ started: peer });

        const sub = vi.fn();
        wiring.bus.subscribe(sub);

        expect(() => bm.onHookLogin(4242, '12345', {} as never)).not.toThrow();
        // The state-wiring listener still ran (BridgeManager isolates exceptions
        // per listener).
        expect(sub).toHaveBeenCalledWith('qq-list');
        expect(sub).toHaveBeenCalledWith('connections');
    });
});
