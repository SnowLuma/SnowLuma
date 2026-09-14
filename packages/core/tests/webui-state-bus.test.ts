import { describe, expect, it, vi } from 'vitest';
import { StateBus, type StateResource } from '../src/webui/state-bus';

describe('StateBus', () => {
  it('delivers a publish to a single subscriber with the resource kind', () => {
    const bus = new StateBus();
    const seen: StateResource[] = [];
    bus.subscribe((r) => seen.push(r));

    bus.publish('processes');
    bus.publish('qq-list');
    bus.publish('connections');

    expect(seen).toEqual(['processes', 'qq-list', 'connections']);
  });

  it('fans out one publish to every subscriber', () => {
    const bus = new StateBus();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);
    bus.subscribe(c);

    bus.publish('processes');

    expect(a).toHaveBeenCalledExactlyOnceWith('processes');
    expect(b).toHaveBeenCalledExactlyOnceWith('processes');
    expect(c).toHaveBeenCalledExactlyOnceWith('processes');
  });

  it('returns an unsubscribe handle that stops future emits without touching the others', () => {
    const bus = new StateBus();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = bus.subscribe(a);
    bus.subscribe(b);

    bus.publish('processes');
    unsubA();
    bus.publish('qq-list');

    expect(a).toHaveBeenCalledExactlyOnceWith('processes');
    expect(b).toHaveBeenCalledTimes(2);
    expect(b.mock.calls).toEqual([['processes'], ['qq-list']]);
  });

  it('is idempotent on double-unsubscribe', () => {
    const bus = new StateBus();
    const a = vi.fn();
    const unsubA = bus.subscribe(a);
    unsubA();
    unsubA();
    bus.publish('processes');
    expect(a).not.toHaveBeenCalled();
  });

  it('isolates subscriber exceptions — one throwing listener does not block the others or future publishes', () => {
    const bus = new StateBus();
    const before = vi.fn();
    const thrower = vi.fn(() => { throw new Error('boom'); });
    const after = vi.fn();
    bus.subscribe(before);
    bus.subscribe(thrower);
    bus.subscribe(after);

    expect(() => bus.publish('processes')).not.toThrow();
    expect(before).toHaveBeenCalledExactlyOnceWith('processes');
    expect(after).toHaveBeenCalledExactlyOnceWith('processes');

    bus.publish('qq-list');
    expect(before).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it('dispose() drops every subscriber and silently swallows further publishes', () => {
    const bus = new StateBus();
    const a = vi.fn();
    bus.subscribe(a);
    bus.dispose();
    bus.publish('processes');
    expect(a).not.toHaveBeenCalled();
  });

  it('a subscriber that subscribes a second time inside its own callback observes the FOLLOWING publish, not this one', () => {
    const bus = new StateBus();
    const second = vi.fn();
    const first = vi.fn(() => { bus.subscribe(second); });
    bus.subscribe(first);

    bus.publish('processes');
    expect(first).toHaveBeenCalledExactlyOnceWith('processes');
    // The just-added subscriber must not receive the in-flight publish — that
    // would surprise SSE handlers that subscribe lazily during an emit fan-out.
    expect(second).not.toHaveBeenCalled();

    bus.publish('qq-list');
    expect(second).toHaveBeenCalledExactlyOnceWith('qq-list');
  });

  it('a subscriber that unsubscribes a peer mid-emit lets the survivor still receive THIS publish', () => {
    const bus = new StateBus();
    const order: string[] = [];
    let unsubB!: () => void;
    bus.subscribe(() => { order.push('a'); unsubB(); });
    unsubB = bus.subscribe(() => { order.push('b'); });
    bus.subscribe(() => { order.push('c'); });

    bus.publish('processes');
    // Snapshot semantics: the fan-out iterates a copy, so peer-unsubscribe
    // does not skip any other listener that was attached when publish started.
    expect(order).toEqual(['a', 'b', 'c']);

    order.length = 0;
    bus.publish('qq-list');
    expect(order).toEqual(['a', 'c']);
  });
});
