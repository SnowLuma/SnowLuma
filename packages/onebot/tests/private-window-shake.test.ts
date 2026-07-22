import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '../../core/src/bridge/bridge-interface';
import type { OneBotInstanceContext } from '../src/instance-context';
import {
  sendGroupMessage,
  sendPrivateForwardMessage,
  sendPrivateMessage,
} from '../src/modules/message-actions';
import { TempSessionStore } from '../src/temp-session-store';

const receipt = {
  messageId: 1,
  sequence: 100,
  clientSequence: 0,
  random: 1,
  timestamp: 1_700_000_000,
};

function makeContext(messageApi: Record<string, ReturnType<typeof vi.fn>>): OneBotInstanceContext {
  return {
    uin: '10001',
    selfId: 10001,
    bridge: {
      identity: { nickname: 'SnowLuma' },
      resolveUserUid: vi.fn(),
      apis: { message: messageApi },
    } as unknown as BridgeInterface,
    messageStore: {
      findEvent: () => null,
      findMeta: () => null,
      storeEvent: vi.fn(),
    } as never,
    cacheMessageMeta: vi.fn(),
    mediaStore: {} as never,
    tempSessions: new TempSessionStore(),
    musicSignUrl: '',
  } as unknown as OneBotInstanceContext;
}

describe('private window shake messages', () => {
  it('sends a poke segment through the ordinary friend private path', async () => {
    const sendPrivate = vi.fn(async () => ({ ...receipt, clientSequence: 9 }));
    const ctx = makeContext({ sendPrivate });

    await sendPrivateMessage(ctx, 67890, [
      { type: 'poke', data: { type: 1 } },
    ], false);

    expect(sendPrivate).toHaveBeenCalledWith(67890, [
      { type: 'poke', subType: 1 },
    ]);
  });

  it('normalizes the legacy shake segment to the same private element', async () => {
    const sendPrivate = vi.fn(async () => ({ ...receipt, clientSequence: 9 }));
    const ctx = makeContext({ sendPrivate });

    await sendPrivateMessage(ctx, 67890, [
      { type: 'shake', data: {} },
    ], false);

    expect(sendPrivate).toHaveBeenCalledWith(67890, [
      { type: 'poke', subType: 1 },
    ]);
  });

  it('rejects mixed private content before resolving an earlier segment', async () => {
    const sendPrivate = vi.fn(async () => ({ ...receipt, clientSequence: 9 }));
    const ctx = makeContext({ sendPrivate });

    await expect(sendPrivateMessage(ctx, 67890, [
      { type: 'at', data: { qq: 12345 } },
      { type: 'poke', data: { type: 1 } },
    ], false)).rejects.toMatchObject({
      code: 'UNSENDABLE_TYPE',
      elementType: 'poke',
      message: expect.stringContaining('only segment'),
    });

    expect(ctx.bridge.resolveUserUid).not.toHaveBeenCalled();
    expect(sendPrivate).not.toHaveBeenCalled();
  });

  it('rejects group window shakes before resolving an earlier segment', async () => {
    const sendGroup = vi.fn(async () => receipt);
    const ctx = makeContext({ sendGroup });

    await expect(sendGroupMessage(ctx, 12345, [
      { type: 'at', data: { qq: 12345 } },
      { type: 'poke', data: { type: 1 } },
    ], false)).rejects.toMatchObject({
      code: 'UNSENDABLE_TYPE',
      elementType: 'poke',
      message: expect.stringContaining('direct private chat'),
    });

    expect(ctx.bridge.resolveUserUid).not.toHaveBeenCalled();
    expect(sendGroup).not.toHaveBeenCalled();
  });

  it('rejects poke segments in group temporary sessions before calling the bridge', async () => {
    const sendGroupTempMessage = vi.fn(async () => ({ ...receipt, clientSequence: 9 }));
    const ctx = makeContext({ sendGroupTempMessage });
    ctx.tempSessions.record(67890, 12345);

    await expect(sendPrivateMessage(ctx, 67890, [
      { type: 'poke', data: { type: 1 } },
    ], false, 12345)).rejects.toMatchObject({
      code: 'UNSENDABLE_TYPE',
      elementType: 'poke',
      message: expect.stringContaining('direct private chat'),
    });

    expect(sendGroupTempMessage).not.toHaveBeenCalled();
  });

  it('rejects a later forward window shake before parsing an earlier node', async () => {
    const upload = vi.fn();
    const sendPrivate = vi.fn();
    const ctx = makeContext({ sendPrivate });
    (ctx.bridge.apis as unknown as Record<string, unknown>).forward = { upload };

    await expect(sendPrivateForwardMessage(ctx, 67890, [
      {
        type: 'node',
        data: {
          user_id: 10001,
          nickname: 'alice',
          content: [{ type: 'at', data: { qq: 12345 } }],
        },
      },
      {
        type: 'node',
        data: {
          user_id: 10002,
          nickname: 'bob',
          content: [{ type: 'poke', data: { type: 1 } }],
        },
      },
    ])).rejects.toMatchObject({
      code: 'UNSENDABLE_TYPE',
      elementType: 'poke',
    });

    expect(ctx.bridge.resolveUserUid).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(sendPrivate).not.toHaveBeenCalled();
  });
});
