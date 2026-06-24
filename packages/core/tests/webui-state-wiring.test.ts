import { describe, expect, it, vi } from 'vitest';
import { StateBus } from '../src/webui/state-bus';
import { createStateWiring } from '../src/webui/state-wiring';
import { BridgeManager } from '../src/bridge/manager';

describe('createStateWiring', () => {
  it('provides a fresh StateBus and an onSessionsChanged that publishes "processes"', () => {
    const wiring = createStateWiring();
    expect(wiring.bus).toBeInstanceOf(StateBus);
    const sub = vi.fn();
    wiring.bus.subscribe(sub);
    wiring.onSessionsChanged();
    expect(sub).toHaveBeenCalledExactlyOnceWith('processes');
  });

  it('binds a BridgeManager so session-started publishes both "qq-list" and "connections"', () => {
    const wiring = createStateWiring();
    const bm = new BridgeManager();
    wiring.bindBridgeManager(bm);
    const seen: string[] = [];
    wiring.bus.subscribe((r) => seen.push(r));

    // Real onHookLogin path — fires the session-started listener internally
    // exactly once (per uin).
    bm.onHookLogin(4242, '12345', {} as never);
    expect(seen).toEqual(['qq-list', 'connections']);
  });

  it('publishes "qq-list" + "connections" on session-closed', () => {
    const wiring = createStateWiring();
    const bm = new BridgeManager();
    wiring.bindBridgeManager(bm);
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

  it('dispose() unwires onSessionsChanged + BridgeManager listeners (no further publishes)', () => {
    const wiring = createStateWiring();
    const bm = new BridgeManager();
    wiring.bindBridgeManager(bm);
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
    const wiring = createStateWiring();
    const bm = new BridgeManager();
    wiring.bindBridgeManager(bm);

    // A peer subscriber (e.g. OneBotManager) added AFTER state-wiring throws.
    const peer = vi.fn(() => { throw new Error('peer down'); });
    bm.addSessionStartedListener(peer);

    const sub = vi.fn();
    wiring.bus.subscribe(sub);

    expect(() => bm.onHookLogin(4242, '12345', {} as never)).not.toThrow();
    // The state-wiring listener still ran (BridgeManager isolates exceptions
    // per listener).
    expect(sub).toHaveBeenCalledWith('qq-list');
    expect(sub).toHaveBeenCalledWith('connections');
  });
});
