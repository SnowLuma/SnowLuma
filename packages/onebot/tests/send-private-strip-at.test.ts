// Regression coverage for the private-chat-at bug.
//
// Symptom in the wild: bot called `send_private_msg` with a message
// like `[reply, at, text]` — the group-chat convention of quoting +
// @-mentioning the reply target.  QQ ignores mention elements in c2c
// messages so the `at` segment is pointless; worse, it produces a
// broken-looking wire message (the recipient sees a phantom "@QQ号"
// that can't be clicked).
//
// Fix: `sendPrivateMessage` now strips all `at` elements before
// handing the array to the protocol layer.  When the message also
// contains a `reply` segment the strip is silent (it's the normal
// OneBot convention and the caller didn't do anything wrong); without
// a `reply` the strip still happens but a warn is logged.

import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import type { OneBotInstanceContext } from '../src/instance-context';
import { sendPrivateMessage } from '../src/modules/message-actions';

function fakeBridge(overrides: Partial<BridgeInterface> = {}): BridgeInterface {
  return new Proxy(overrides as BridgeInterface, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      throw new Error(`fakeBridge: '${String(prop)}' was not stubbed for this test`);
    },
  });
}

const goodReceipt = {
  messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 1700000000,
};

function makeCtx(bridge: BridgeInterface): OneBotInstanceContext {
  return {
    uin: '10001',
    selfId: 10001,
    bridge,
    messageStore: {
      findEvent: () => null,
      findMeta: () => null,
      resolveReplySequence: () => 42,
    } as any,
    cacheMessageMeta: vi.fn(),
    mediaStore: {} as any,
    musicSignUrl: '',
  } as unknown as OneBotInstanceContext;
}

describe('send_private_msg strips at segments', () => {
  it('reply + at + text → only reply + text reach the wire', async () => {
    const sendPrivate = vi.fn(async (_uin: number, elements: any[]) => {
      // Verify no `at` element reaches the bridge
      const types = elements.map((e: any) => e.type);
      expect(types).not.toContain('at');
      return goodReceipt;
    });
    const bridge = fakeBridge({
      apis: { message: { sendPrivate } } as any,
      resolveUserUid: vi.fn(async () => 'u_peer'),
    } as any);
    const ctx = makeCtx(bridge);

    await sendPrivateMessage(ctx, 67890, [
      { type: 'reply', data: { id: '-2050237785' } },
      { type: 'at', data: { qq: '67890' } },
      { type: 'text', data: { text: ' ' } },
      { type: 'text', data: { text: 'quoted reply text' } },
    ] as any, false);

    expect(sendPrivate).toHaveBeenCalledOnce();
    const sentElements = sendPrivate.mock.calls[0]![1] as any[];
    const sentTypes = sentElements.map(e => e.type);
    expect(sentTypes).toEqual(['reply', 'text', 'text']);
  });

  it('at-only message (no reply) is also stripped, throws "message is empty"', async () => {
    const sendPrivate = vi.fn();
    const bridge = fakeBridge({
      apis: { message: { sendPrivate } } as any,
      resolveUserUid: vi.fn(async () => 'u_peer'),
    } as any);
    const ctx = makeCtx(bridge);

    await expect(sendPrivateMessage(ctx, 67890, [
      { type: 'at', data: { qq: '67890' } },
    ] as any, false)).rejects.toThrow('message is empty');

    expect(sendPrivate).not.toHaveBeenCalled();
  });

  it('text + at (without reply) strips at and sends remaining text', async () => {
    const sendPrivate = vi.fn(async (_uin: number, _elements: any[]) => goodReceipt);
    const bridge = fakeBridge({
      apis: { message: { sendPrivate } } as any,
      resolveUserUid: vi.fn(async () => 'u_peer'),
    } as any);
    const ctx = makeCtx(bridge);

    await sendPrivateMessage(ctx, 67890, [
      { type: 'text', data: { text: 'hello' } },
      { type: 'at', data: { qq: '67890' } },
    ] as any, false);

    expect(sendPrivate).toHaveBeenCalledOnce();
    const sentElements = sendPrivate.mock.calls[0]![1] as any[];
    expect(sentElements).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('multiple at segments are all stripped', async () => {
    const sendPrivate = vi.fn(async (_uin: number, _elements: any[]) => goodReceipt);
    const bridge = fakeBridge({
      apis: { message: { sendPrivate } } as any,
      resolveUserUid: vi.fn(async () => 'u_peer'),
    } as any);
    const ctx = makeCtx(bridge);

    await sendPrivateMessage(ctx, 67890, [
      { type: 'reply', data: { id: '123' } },
      { type: 'at', data: { qq: '67890' } },
      { type: 'at', data: { qq: '12345' } },
      { type: 'text', data: { text: 'hi' } },
    ] as any, false);

    expect(sendPrivate).toHaveBeenCalledOnce();
    const sentElements = sendPrivate.mock.calls[0]![1] as any[];
    const sentTypes = sentElements.map((e: any) => e.type);
    expect(sentTypes).not.toContain('at');
    expect(sentTypes).toContain('reply');
    expect(sentTypes).toContain('text');
  });

  it('group messages are NOT affected (at segments preserved)', async () => {
    // Sanity: import sendGroupMessage and verify at segments pass through
    const { sendGroupMessage } = await import('../src/modules/message-actions');

    const sendGroup = vi.fn(async (_groupId: number, elements: any[]) => {
      return goodReceipt;
    });
    const bridge = fakeBridge({
      apis: { message: { sendGroup } } as any,
      resolveUserUid: vi.fn(async () => 'u_peer'),
    } as any);
    const ctx = makeCtx(bridge);

    await sendGroupMessage(ctx, 99999, [
      { type: 'reply', data: { id: '123' } },
      { type: 'at', data: { qq: '67890' } },
      { type: 'text', data: { text: 'hi' } },
    ] as any, false);

    expect(sendGroup).toHaveBeenCalledOnce();
    const sentElements = sendGroup.mock.calls[0]![1] as any[];
    const sentTypes = sentElements.map((e: any) => e.type);
    expect(sentTypes).toContain('at');
  });
});
