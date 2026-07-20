import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '../../core/src/bridge/bridge-interface';
import { OneBotInstance } from '../src/instance';
import { buildApiContext, type OneBotInstanceContext } from '../src/instance-context';
import { hashMessageIdInt32, PRIVATE_MESSAGE_EVENT } from '../src/message-id';
import { TempSessionStore } from '../src/temp-session-store';
import type { JsonObject, OneBotConfig } from '../src/types';

const SELF_ID = 10001;
const PEER_ID = 20002;
const RECEIPT = {
  messageId: 123456,
  sequence: 87,
  clientSequence: 9,
  random: 123456,
  timestamp: 1_700_000_000,
};

function makeContext(receipt = RECEIPT): {
  ctx: OneBotInstanceContext;
  dispatchEvent: ReturnType<typeof vi.fn<(event: JsonObject) => void>>;
  events: Map<number, JsonObject>;
} {
  const events = new Map<number, JsonObject>();
  const dispatchEvent = vi.fn<(event: JsonObject) => void>();
  const bridge = {
    identity: { nickname: 'SnowLuma' },
    apis: {
      message: {
        sendPrivate: vi.fn(async () => receipt),
        sendGroupTempMessage: vi.fn(async () => receipt),
      },
    },
    resolveUserUid: vi.fn(async () => 'u_peer'),
  } as unknown as BridgeInterface;

  const ctx = {
    uin: String(SELF_ID),
    selfId: SELF_ID,
    bridge,
    messageStore: {
      findEvent: (messageId: number) => events.get(messageId) ?? null,
      findMeta: () => null,
      resolveReplySequence: () => null,
      storeEvent: (messageId: number, _isGroup: boolean, _sessionId: number, _sequence: number, _eventName: string, event: JsonObject) => {
        events.set(messageId, event);
      },
    },
    mediaStore: {},
    reactionStore: {},
    tempSessions: new TempSessionStore(),
    converterCtx: {},
    config: {
      networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
    } as OneBotConfig,
    cacheMessageMeta: vi.fn(),
    dispatchEvent,
  } as unknown as OneBotInstanceContext;

  return { ctx, dispatchEvent, events };
}

interface InstanceHarness {
  dispatch(event: JsonObject, source: 'send' | 'bridge'): void;
  emitEvent: ReturnType<typeof vi.fn<(event: JsonObject) => Promise<void>>>;
  stored: Map<number, JsonObject>;
}

function makeInstanceHarness(): InstanceHarness {
  const stored = new Map<number, JsonObject>();
  const emitEvent = vi.fn(async (_event: JsonObject) => {});
  const instance = Object.create(OneBotInstance.prototype) as OneBotInstance;
  Object.assign(instance as unknown as Record<string, unknown>, {
    bridge: { identity: {} },
    ctx: {
      config: {
        statusCommand: { enabled: false, swallow: false, cooldownSeconds: 5, trigger: '#sl' },
      },
    },
    log: { success: vi.fn(), trace: vi.fn(), warn: vi.fn() },
    messageStore: {
      findEvent: (messageId: number) => stored.get(messageId) ?? null,
      storeEvent: (messageId: number, _isGroup: boolean, _sessionId: number, _sequence: number, _eventName: string, event: JsonObject) => {
        stored.set(messageId, event);
      },
    },
    networkManager: { emitEvent },
    statusCommandCooldown: new Map(),
    pendingSelfSentEchoes: new Map(),
  });
  const dispatch = (instance as unknown as {
    dispatchEvent(event: JsonObject, source: 'send' | 'bridge'): void;
  }).dispatchEvent.bind(instance);
  return { dispatch, emitEvent, stored };
}

function privateSentEvent(overrides: JsonObject = {}): JsonObject {
  return {
    time: RECEIPT.timestamp,
    self_id: SELF_ID,
    post_type: 'message_sent',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 987654,
    message_seq: RECEIPT.sequence,
    user_id: SELF_ID,
    target_id: PEER_ID,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    sender: { user_id: SELF_ID, nickname: 'SnowLuma' },
    ...overrides,
  };
}

describe('OneBot self-sent events', () => {
  it('reports a private message sent through an action', async () => {
    const { ctx, dispatchEvent } = makeContext();
    const api = buildApiContext(ctx);

    const result = await api.sendPrivateMessage(PEER_ID, [
      { type: 'text', data: { text: 'hello' } },
    ], false);

    expect(result.messageId).not.toBe(0);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      post_type: 'message_sent',
      message_type: 'private',
      sub_type: 'friend',
      self_id: SELF_ID,
      user_id: SELF_ID,
      target_id: PEER_ID,
      message_seq: RECEIPT.sequence,
    }), 'send');
  });

  it('does not report a later QQ echo after the action event', () => {
    const { dispatch, emitEvent, stored } = makeInstanceHarness();
    const sentEvent = privateSentEvent();
    const qqEcho: JsonObject = {
      ...sentEvent,
      raw_message: 'canonical echo',
      sender: { user_id: SELF_ID, nickname: 'Server profile' },
    };

    dispatch(sentEvent, 'send');
    dispatch(qqEcho, 'bridge');

    expect(emitEvent).toHaveBeenCalledOnce();
    expect(stored.get(987654)?.raw_message).toBe('canonical echo');
  });

  it('does not dispatch an event for a receipt without a reliable sequence', async () => {
    const { ctx, dispatchEvent } = makeContext({ ...RECEIPT, sequence: 0 });
    const api = buildApiContext(ctx);

    await api.sendPrivateMessage(PEER_ID, [
      { type: 'text', data: { text: 'hello' } },
    ], false);

    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('keeps an earlier QQ echo and does not report the later action event', async () => {
    const { ctx, dispatchEvent, events } = makeContext();
    const messageId = hashMessageIdInt32(RECEIPT.sequence, PEER_ID, PRIVATE_MESSAGE_EVENT);
    const qqEcho: JsonObject = {
      time: RECEIPT.timestamp,
      self_id: SELF_ID,
      post_type: 'message_sent',
      message_type: 'private',
      sub_type: 'friend',
      message_id: messageId,
      message_seq: RECEIPT.sequence,
      user_id: SELF_ID,
      target_id: PEER_ID,
      message: [{ type: 'text', data: { text: 'hello' } }],
      raw_message: 'canonical echo',
      sender: { user_id: SELF_ID, nickname: 'Server profile' },
    };
    events.set(messageId, qqEcho);

    const api = buildApiContext(ctx);
    const result = await api.sendPrivateMessage(PEER_ID, [
      { type: 'text', data: { text: 'hello' } },
    ], false);

    expect(result.messageId).toBe(messageId);
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(events.get(messageId)).toBe(qqEcho);
  });

  it('does not invent a friend event for a group temporary-session send', async () => {
    const groupId = 30003;
    const { ctx, dispatchEvent } = makeContext();
    ctx.tempSessions.record(PEER_ID, groupId);

    const api = buildApiContext(ctx);
    await api.sendPrivateMessage(PEER_ID, [
      { type: 'text', data: { text: 'hello' } },
    ], false, groupId);

    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('does not suppress a bridge echo that was cached but never reported', () => {
    const { dispatch, emitEvent, stored } = makeInstanceHarness();
    const cached: JsonObject = {
      time: RECEIPT.timestamp,
      self_id: SELF_ID,
      post_type: 'message_sent',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 7654321,
      message_seq: RECEIPT.sequence,
      group_id: 30003,
      user_id: SELF_ID,
      message: [],
      raw_message: '',
      sender: { user_id: SELF_ID },
    };
    stored.set(7654321, cached);

    dispatch({ ...cached, raw_message: 'canonical echo' }, 'bridge');

    expect(emitEvent).toHaveBeenCalledOnce();
    expect(stored.get(7654321)?.raw_message).toBe('canonical echo');
  });

  it('does not suppress a hash collision from another conversation', () => {
    const { dispatch, emitEvent } = makeInstanceHarness();
    const sentEvent = privateSentEvent();

    dispatch(sentEvent, 'send');
    dispatch({ ...sentEvent, target_id: PEER_ID + 1 }, 'bridge');

    expect(emitEvent).toHaveBeenCalledTimes(2);
  });
});
