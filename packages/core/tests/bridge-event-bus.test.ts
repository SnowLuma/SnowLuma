import { describe, expect, it, vi } from 'vitest';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { FriendMessage, GroupMessage } from '@snowluma/protocol/events';

function makeFriendMessage(): FriendMessage {
  return {
    kind: 'friend_message',
    time: 1700000000,
    selfUin: 10001,
    senderUin: 22222,
    senderNick: 'peer',
    msgSeq: 1,
    msgId: 1,
    elements: [{ type: 'text', text: 'hi' }],
  };
}

function makeGroupMessage(): GroupMessage {
  return {
    kind: 'group_message', groupName: '',
    time: 1700000000,
    selfUin: 10001,
    groupId: 99999,
    senderUin: 22222,
    senderNick: 'peer',
    senderCard: '',
    senderRole: 'member',
    msgSeq: 2,
    msgId: 2,
    elements: [{ type: 'text', text: 'hi' }],
  };
}

describe('BridgeEventBus', () => {
  it('routes events only to subscribers of the matching kind', async () => {
    const bus = new BridgeEventBus();
    const friend = vi.fn();
    const group = vi.fn();
    bus.on('friend_message', friend);
    bus.on('group_message', group);

    await bus.emit(makeFriendMessage());
    await bus.emit(makeGroupMessage());

    expect(friend).toHaveBeenCalledTimes(1);
    expect(group).toHaveBeenCalledTimes(1);
  });

  it('runs every subscriber in parallel for one kind', async () => {
    const bus = new BridgeEventBus();
    const order: string[] = [];
    bus.on('friend_message', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow');
    });
    bus.on('friend_message', () => {
      order.push('fast');
    });

    await bus.emit(makeFriendMessage());
    // The synchronous handler must finish before the async one — proves we
    // don't serialize handlers across the kind.
    expect(order).toEqual(['fast', 'slow']);
  });

  it('isolates handler errors and reports them via onError', async () => {
    const seen: Array<{ kind: string; err: unknown }> = [];
    const bus = new BridgeEventBus({ onError: (kind, err) => seen.push({ kind, err }) });
    const ok = vi.fn();
    bus.on('friend_message', () => {
      throw new Error('boom');
    });
    bus.on('friend_message', ok);

    await bus.emit(makeFriendMessage());

    expect(ok).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('friend_message');
    expect((seen[0].err as Error).message).toBe('boom');
  });

  it('supports unsubscribe via the returned disposer', async () => {
    const bus = new BridgeEventBus();
    const handler = vi.fn();
    const off = bus.on('friend_message', handler);

    await bus.emit(makeFriendMessage());
    expect(handler).toHaveBeenCalledTimes(1);

    off();
    await bus.emit(makeFriendMessage());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports onAny and isolates its errors separately', async () => {
    const seen: Array<{ kind: string; err: unknown }> = [];
    const bus = new BridgeEventBus({ onError: (kind, err) => seen.push({ kind, err }) });
    const tap = vi.fn();
    bus.onAny(tap);
    bus.onAny(() => { throw new Error('any-fail'); });

    await bus.emit(makeFriendMessage());
    await bus.emit(makeGroupMessage());

    expect(tap).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.kind === '*')).toBe(true);
  });

  it('reports has() based on per-kind + onAny subscriptions', () => {
    const bus = new BridgeEventBus();
    expect(bus.has('friend_message')).toBe(false);

    const off = bus.on('friend_message', () => {});
    expect(bus.has('friend_message')).toBe(true);
    off();
    expect(bus.has('friend_message')).toBe(false);

    bus.onAny(() => {});
    expect(bus.has('friend_message')).toBe(true);
  });

  it('clear() drops every subscriber', async () => {
    const bus = new BridgeEventBus();
    const handler = vi.fn();
    bus.on('friend_message', handler);
    bus.onAny(handler);

    bus.clear();
    await bus.emit(makeFriendMessage());

    expect(handler).not.toHaveBeenCalled();
  });
});
