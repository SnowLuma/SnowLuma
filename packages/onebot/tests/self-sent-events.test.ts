import { describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  getLogLevel,
  runWithRequestId,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';
import type { BridgeInterface } from '../../core/src/bridge/bridge-interface';
import { ApiHandler } from '../src/api-handler';
import { OneBotInstance } from '../src/instance';
import { buildApiContext, type OneBotInstanceContext } from '../src/instance-context';
import { hashMessageIdInt32, PRIVATE_NT_MESSAGE_EVENT } from '../src/message-id';
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
type Receipt = typeof RECEIPT;

function makeContext(receiptOrReceipts: Receipt | Receipt[] = RECEIPT): {
  ctx: OneBotInstanceContext;
  dispatchEvent: ReturnType<typeof vi.fn<(event: JsonObject) => void>>;
  events: Map<number, JsonObject>;
} {
  const receipts = Array.isArray(receiptOrReceipts) ? receiptOrReceipts : [receiptOrReceipts];
  let receiptIndex = 0;
  const nextReceipt = () => {
    const receipt = receipts[receiptIndex++];
    if (!receipt) throw new Error('unexpected extra private send');
    return receipt;
  };
  const events = new Map<number, JsonObject>();
  const dispatchEvent = vi.fn<(event: JsonObject) => void>();
  const bridge = {
    identity: { nickname: 'SnowLuma' },
    apis: {
      message: {
        sendPrivate: vi.fn(async () => nextReceipt()),
        sendGroupTempMessage: vi.fn(async () => nextReceipt()),
        sendC2cFile: vi.fn(async () => nextReceipt()),
      },
      groupFile: {
        uploadPrivate: vi.fn(async () => ({
          fileId: 'uploaded-file-uuid',
          fileHash: 'uploaded-file-hash',
        })),
      },
      forward: {
        upload: vi.fn(async () => 'forward-res-id'),
      },
    },
    resolveUserUid: vi.fn(async () => 'u_peer'),
    recallUploadedFile: vi.fn((fileId: string) => fileId === 'uploaded-file-uuid'
      ? {
        fileId,
        scope: 'private',
        userId: PEER_ID,
        fileName: 'inline.txt',
        fileSize: 3,
        fileMd5: new Uint8Array(16),
        fileSha1: new Uint8Array(20),
        fileHash: 'uploaded-file-hash',
        rememberedAt: Date.now(),
      }
      : undefined),
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

function makeInstanceHarness(options: {
  statusCommand?: { enabled: boolean; swallow: boolean; cooldownSeconds: number; trigger: string };
  logger?: ReturnType<typeof createLogger>;
} = {}): InstanceHarness {
  const stored = new Map<number, JsonObject>();
  const emitEvent = vi.fn(async (_event: JsonObject) => {});
  const instance = Object.create(OneBotInstance.prototype) as OneBotInstance;
  Object.assign(instance as unknown as Record<string, unknown>, {
    bridge: { identity: {} },
    ctx: {
      config: {
        statusCommand: options.statusCommand
          ?? { enabled: false, swallow: false, cooldownSeconds: 5, trigger: '#sl' },
      },
    },
    log: options.logger ?? { success: vi.fn(), trace: vi.fn(), warn: vi.fn() },
    messageStore: {
      findEvent: (messageId: number) => stored.get(messageId) ?? null,
      storeEvent: (messageId: number, _isGroup: boolean, _sessionId: number, _sequence: number, _eventName: string, event: JsonObject) => {
        stored.set(messageId, event);
      },
    },
    networkManager: { emitEvent },
    acceptingActions: true,
    uin: String(SELF_ID),
    statusCommandCooldown: new Map([['p:20002', Date.now()]]),
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
    message_seq: RECEIPT.clientSequence,
    user_id: SELF_ID,
    target_id: PEER_ID,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    sender: { user_id: SELF_ID, nickname: 'SnowLuma' },
    ...overrides,
  };
}

describe('OneBot self-sent events', () => {
  it('reports upload_private_file as a private self-sent message', async () => {
    const { ctx, dispatchEvent } = makeContext();
    const handler = new ApiHandler(buildApiContext(ctx));

    const response = await handler.handle('upload_private_file', {
      user_id: PEER_ID,
      file: 'base64://AQID',
      name: 'inline.txt',
    });

    expect(response).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { file_id: 'uploaded-file-uuid' },
    });
    expect(ctx.bridge.apis.groupFile.uploadPrivate).toHaveBeenCalledWith(
      PEER_ID,
      'base64://AQID',
      'inline.txt',
      true,
      false,
    );
    expect(ctx.bridge.apis.message.sendC2cFile).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      post_type: 'message_sent',
      message_type: 'private',
      self_id: SELF_ID,
      user_id: SELF_ID,
      target_id: PEER_ID,
      message_seq: RECEIPT.clientSequence,
      message: [{
        type: 'file',
        data: expect.objectContaining({
          file_id: 'uploaded-file-uuid',
          file: 'inline.txt',
          file_size: 3,
        }),
      }],
    }), 'send');
  });

  it('fails upload_private_file when publishing the private file fails', async () => {
    const { ctx, dispatchEvent } = makeContext();
    vi.mocked(ctx.bridge.apis.message.sendC2cFile).mockRejectedValueOnce(
      new Error('private file publication rejected'),
    );
    const handler = new ApiHandler(buildApiContext(ctx));

    const response = await handler.handle('upload_private_file', {
      user_id: PEER_ID,
      file: 'base64://AQID',
      name: 'inline.txt',
    });

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 100,
      wording: 'private file publication rejected',
    });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('does not report upload_private_file when upload_file is disabled', async () => {
    const { ctx, dispatchEvent } = makeContext();
    const handler = new ApiHandler(buildApiContext(ctx));

    const response = await handler.handle('upload_private_file', {
      user_id: PEER_ID,
      file: 'base64://AQID',
      name: 'inline.txt',
      upload_file: false,
    });

    expect(response).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { file_id: 'uploaded-file-uuid' },
    });
    expect(ctx.bridge.apis.message.sendC2cFile).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

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
      message_seq: RECEIPT.clientSequence,
    }), 'send');
  });

  it('[#288] reports a private forward built through an action', async () => {
    const { ctx, dispatchEvent } = makeContext();
    const api = buildApiContext(ctx);

    const result = await api.sendPrivateForwardMsg(PEER_ID, [{
      type: 'node',
      data: {
        user_id: SELF_ID,
        nickname: 'SnowLuma',
        content: [{ type: 'text', data: { text: 'forwarded' } }],
      },
    }]);

    expect(result.messageId).not.toBe(0);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      post_type: 'message_sent',
      message_type: 'private',
      self_id: SELF_ID,
      user_id: SELF_ID,
      target_id: PEER_ID,
      message_seq: RECEIPT.clientSequence,
      message: [expect.objectContaining({
        type: 'forward',
      })],
    }), 'send');
  });

  it('[#288] reports a cached message forwarded to a friend through an action', async () => {
    const { ctx, dispatchEvent, events } = makeContext();
    const sourceMessageId = 55;
    events.set(sourceMessageId, {
      message_id: sourceMessageId,
      message_type: 'private',
      user_id: PEER_ID,
      message: [{ type: 'text', data: { text: 'forward me' } }],
    });
    const api = buildApiContext(ctx);

    const result = await api.forwardSingleMsg(sourceMessageId, { userId: PEER_ID });

    expect(result.messageId).not.toBe(0);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      post_type: 'message_sent',
      message_type: 'private',
      self_id: SELF_ID,
      user_id: SELF_ID,
      target_id: PEER_ID,
      message_seq: RECEIPT.clientSequence,
      message: [{ type: 'text', data: { text: 'forward me' } }],
    }), 'send');
  });

  it('[#288] does not report a private forward without a reliable sequence', async () => {
    const { ctx, dispatchEvent, events } = makeContext({ ...RECEIPT, sequence: 0 });
    const sourceMessageId = 56;
    events.set(sourceMessageId, {
      message_id: sourceMessageId,
      message_type: 'private',
      user_id: PEER_ID,
      message: [{ type: 'text', data: { text: 'forward me' } }],
    });
    const api = buildApiContext(ctx);

    await api.forwardSingleMsg(sourceMessageId, { userId: PEER_ID });

    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('reports a private file sent through an action', async () => {
    const { ctx, dispatchEvent } = makeContext();
    const api = buildApiContext(ctx);

    const result = await api.sendPrivateMessage(PEER_ID, [{
      type: 'file',
      data: {
        file_id: 'file-uuid',
        name: 'report.txt',
        size: 128,
        md5: '00112233445566778899aabbccddeeff',
      },
    }], false);

    expect(result.messageId).not.toBe(0);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      post_type: 'message_sent',
      message_type: 'private',
      self_id: SELF_ID,
      user_id: SELF_ID,
      target_id: PEER_ID,
      message: [expect.objectContaining({
        type: 'file',
        data: expect.objectContaining({
          file_id: 'file-uuid',
          file: 'report.txt',
          file_size: 128,
        }),
      })],
    }), 'send');
  });

  it('reports a private file uploaded and sent through an action', async () => {
    const { ctx, dispatchEvent } = makeContext();
    const api = buildApiContext(ctx);

    await api.sendPrivateMessage(PEER_ID, [{
      type: 'file',
      data: {
        file: 'base64://AQID',
        name: 'inline.txt',
      },
    }], false);

    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      post_type: 'message_sent',
      message_type: 'private',
      target_id: PEER_ID,
      message: [expect.objectContaining({
        type: 'file',
        data: expect.objectContaining({
          file: 'inline.txt',
          url: 'base64://AQID',
        }),
      })],
    }), 'send');
  });

  it('reports each QQ message produced by a mixed private action', async () => {
    const fileReceipt: Receipt = {
      messageId: 654321,
      sequence: 88,
      clientSequence: 10,
      random: 654321,
      timestamp: RECEIPT.timestamp + 1,
    };
    const { ctx, dispatchEvent } = makeContext([RECEIPT, fileReceipt]);
    const api = buildApiContext(ctx);

    const result = await api.sendPrivateMessage(PEER_ID, [
      { type: 'text', data: { text: 'attachment:' } },
      {
        type: 'file',
        data: {
          file_id: 'mixed-file-uuid',
          name: 'mixed.txt',
          size: 64,
          md5: '00112233445566778899aabbccddeeff',
        },
      },
    ], false);

    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      post_type: 'message_sent',
      message_seq: RECEIPT.clientSequence,
      message: [{ type: 'text', data: { text: 'attachment:' } }],
    });
    expect(dispatchEvent.mock.calls[1]?.[0]).toMatchObject({
      post_type: 'message_sent',
      message_seq: fileReceipt.clientSequence,
      message: [{
        type: 'file',
        data: expect.objectContaining({ file_id: 'mixed-file-uuid' }),
      }],
    });
    expect(result.messageId).toBe(hashMessageIdInt32(
      fileReceipt.sequence,
      PEER_ID,
      PRIVATE_NT_MESSAGE_EVENT,
    ));
  });

  it('reports each file in a multi-file private action separately', async () => {
    const secondReceipt: Receipt = {
      messageId: 654321,
      sequence: 88,
      clientSequence: 10,
      random: 654321,
      timestamp: RECEIPT.timestamp + 1,
    };
    const { ctx, dispatchEvent } = makeContext([RECEIPT, secondReceipt]);
    const api = buildApiContext(ctx);

    await api.sendPrivateMessage(PEER_ID, [
      {
        type: 'file',
        data: {
          file_id: 'first-file',
          name: 'first.txt',
          size: 1,
          md5: '00112233445566778899aabbccddeeff',
        },
      },
      {
        type: 'file',
        data: {
          file_id: 'second-file',
          name: 'second.txt',
          size: 2,
          md5: 'ffeeddccbbaa00998877665544332211',
        },
      },
    ], false);

    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(dispatchEvent.mock.calls.map(([event]) =>
      ((event.message as JsonObject[])[0]?.data as JsonObject)?.file_id,
    )).toEqual(['first-file', 'second-file']);
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

  it('records one truthful handoff terminal for reporting, duplicate suppression, and status suppression', () => {
    const previousLevel = getLogLevel();
    const entries: LogEntry[] = [];
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    setLogLevel('trace');
    try {
      const logger = createLogger('Event').child({ uin: SELF_ID });
      const reporting = makeInstanceHarness({ logger });
      runWithRequestId(6001, () => reporting.dispatch(privateSentEvent(), 'send'));
      expect(reporting.emitEvent).toHaveBeenCalledOnce();

      const duplicate = makeInstanceHarness({ logger });
      runWithRequestId(6002, () => {
        duplicate.dispatch(privateSentEvent(), 'send');
        duplicate.dispatch(privateSentEvent({ raw_message: 'canonical' }), 'bridge');
      });
      expect(duplicate.emitEvent).toHaveBeenCalledOnce();

      const status = makeInstanceHarness({
        logger,
        statusCommand: { enabled: true, swallow: true, cooldownSeconds: 5, trigger: '#sl' },
      });
      runWithRequestId(6003, () => status.dispatch(privateSentEvent({
        post_type: 'message',
        user_id: PEER_ID,
        target_id: undefined,
        raw_message: '#sl',
        message: [{ type: 'text', data: { text: '#sl' } }],
      }), 'bridge'));
      expect(status.emitEvent).not.toHaveBeenCalled();

      const terminals = entries.filter((entry) => (
        entry.scope === 'Event'
        && entry.level === 'trace'
        && entry.message.startsWith('event_terminal')
      ));
      expect(terminals.filter((entry) => entry.req === 6001)).toHaveLength(1);
      expect(terminals.find((entry) => entry.req === 6001)?.message).toContain('outcome=reporting_started');
      expect(terminals.filter((entry) => entry.req === 6002)).toHaveLength(2);
      expect(terminals.find((entry) => (
        entry.req === 6002 && entry.message.includes('reason=duplicate_self_echo')
      ))?.message).toContain('outcome=suppressed');
      expect(terminals.filter((entry) => entry.req === 6003)).toHaveLength(1);
      expect(terminals[terminals.length - 1]?.message).toContain('outcome=suppressed reason=status_command');
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }
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
    const messageId = hashMessageIdInt32(RECEIPT.sequence, PEER_ID, PRIVATE_NT_MESSAGE_EVENT);
    const qqEcho: JsonObject = {
      time: RECEIPT.timestamp,
      self_id: SELF_ID,
      post_type: 'message_sent',
      message_type: 'private',
      sub_type: 'friend',
      message_id: messageId,
      message_seq: RECEIPT.clientSequence,
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
