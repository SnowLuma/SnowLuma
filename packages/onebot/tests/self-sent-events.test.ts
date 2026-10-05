import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  getLogLevel,
  runWithRequestId,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';
import type { MessageElement } from '@snowluma/protocol/events';
import type { BridgeInterface } from '../../core/src/bridge/bridge-interface';
import { ApiHandler } from '../src/api-handler';
import { OneBotInstance } from '../src/instance';
import { buildApiContext, type OneBotInstanceContext } from '../src/instance-context';
import { MediaIndexer } from '../src/media-indexer';
import { MediaStore } from '../src/media-store';
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

/** Upload fingerprints the NTV2 ptt pipeline writes onto a sent voice element. */
const PTT_MD5 = 'aabbccddeeff00112233445566778899';
const PTT_NODE = { fileUuid: 'ptt-resource-uuid', storeId: 1 };

const mediaStores: Array<{ store: MediaStore; dbPath: string }> = [];

/** A real store on a throwaway db — runtime state resolves under the per-worker
 *  temp dir `tests/setup.ts` chdir-s into, so nothing lands in the package. */
function openMediaStore(label: string): MediaStore {
  const dbPath = path.join(
    'data', 'test',
    `self-sent-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const store = new MediaStore(dbPath);
  mediaStores.push({ store, dbPath });
  return store;
}

afterEach(() => {
  for (const { store, dbPath } of mediaStores.splice(0)) {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* already gone */ }
    }
  }
});

interface ContextOptions {
  /** Real store for the tests that exercise media indexing. The default is a
   *  spy-shaped store so unrelated sends stay side-effect free. */
  mediaStore?: MediaStore;
  /** Mirror the NTV2 upload's in-place element annotation
   *  (`packages/protocol/src/highway/ptt-upload.ts:245-249`). The mocked bridge
   *  performs no upload, so a test that needs the annotation asks for it. */
  simulatePttUpload?: boolean;
  getPttUrl?: ReturnType<typeof vi.fn>;
  getPrivatePttUrl?: ReturnType<typeof vi.fn>;
}

function makeContext(
  receiptOrReceipts: Receipt | Receipt[] = RECEIPT,
  options: ContextOptions = {},
): {
  ctx: OneBotInstanceContext;
  dispatchEvent: ReturnType<typeof vi.fn<(event: JsonObject) => void>>;
  events: Map<number, JsonObject>;
  mediaStore: MediaStore;
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
  const mediaStore = options.mediaStore ?? ({
    rememberImage: vi.fn(),
    rememberRecord: vi.fn(),
    rememberVideo: vi.fn(),
  } as unknown as MediaStore);
  const mediaIndexer = new MediaIndexer(mediaStore);
  const bridge = {
    identity: { nickname: 'SnowLuma' },
    apis: {
      message: {
        sendPrivate: vi.fn(async (_userId: number, elements: MessageElement[]) => {
          if (options.simulatePttUpload) {
            for (const element of elements) {
              if (element.type !== 'record') continue;
              Object.assign(element, {
                md5Hex: PTT_MD5,
                sha1Hex: 'bb'.repeat(20),
                fileSize: 1024,
                fileName: `${PTT_MD5}.amr`,
                duration: 3,
                voiceFormat: 1,
                fileId: PTT_NODE.fileUuid,
                mediaNode: PTT_NODE,
              });
            }
          }
          return nextReceipt();
        }),
        sendGroupTempMessage: vi.fn(async () => nextReceipt()),
        sendC2cFile: vi.fn(async () => nextReceipt()),
      },
      groupFile: {
        uploadPrivate: vi.fn(async () => ({
          fileId: 'uploaded-file-uuid',
          fileHash: 'uploaded-file-hash',
        })),
        getPttUrl: options.getPttUrl ?? vi.fn(async () => ''),
        getPrivatePttUrl: options.getPrivatePttUrl ?? vi.fn(async () => ''),
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
      findMedia: () => null,
      findEvent: (messageId: number) => events.get(messageId) ?? null,
      findMeta: () => null,
      resolveReplySequence: () => null,
      storeEvent: (messageId: number, _isGroup: boolean, _sessionId: number, _sequence: number, _eventName: string, event: JsonObject) => {
        events.set(messageId, event);
      },
    },
    mediaStore,
    reactionStore: {},
    tempSessions: new TempSessionStore(),
    converterCtx: {
      selfId: SELF_ID,
      imageUrlResolver: null,
      mediaUrlResolver: null,
      messageIdResolver: null,
      mediaSegmentSink: (mediaType, element, data, isGroup, sessionId) =>
        mediaIndexer.remember(mediaType, element, data, isGroup, sessionId),
    },
    config: {
      networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
    } as OneBotConfig,
    cacheMessageMeta: vi.fn(),
    dispatchEvent,
  } as unknown as OneBotInstanceContext;

  return { ctx, dispatchEvent, events, mediaStore };
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
      findMedia: () => null,
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

  it('indexes a self-sent private voice so get_msg can mint its URL', async () => {
    // The bug: a self-sent voice reached the media store never, so
    // `getRecordInfo` had no `mediaNode` to mint a URL from and `/get_msg`
    // returned a segment whose only media reference was a dead file token.
    const mediaStore = openMediaStore('ptt');
    const getPrivatePttUrl = vi.fn(async () => 'https://ptt.example/c2c.silk?rkey=FRESH');
    const { ctx } = makeContext(RECEIPT, {
      mediaStore,
      simulatePttUpload: true,
      getPrivatePttUrl,
    });
    const api = buildApiContext(ctx);

    const result = await api.sendPrivateMessage(PEER_ID, [{
      type: 'record',
      data: { file: 'base64://QUNBQ0E=' },
    }], false);

    // The NTV2 upload annotates the element in place; the sink must have run
    // for that same element, not a copy taken before the upload.
    const sent = vi.mocked(ctx.bridge.apis.message.sendPrivate).mock.calls[0]![1];
    expect(sent[0]).toMatchObject({
      type: 'record',
      fileId: PTT_NODE.fileUuid,
      mediaNode: PTT_NODE,
    });
    const cached = mediaStore.findRecord(`${PTT_MD5}.amr`);
    expect(cached).toMatchObject({
      file: `${PTT_MD5}.amr`,
      fileId: PTT_NODE.fileUuid,
      mediaNode: PTT_NODE,
      isGroup: false,
      sessionId: PEER_ID,
    });

    const handler = new ApiHandler(api);
    const response = await handler.handle('get_msg', { message_id: result.messageId });

    expect(getPrivatePttUrl).toHaveBeenCalledWith(PTT_NODE);
    expect(response).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: {
        message: [{
          type: 'record',
          data: {
            file: `${PTT_MD5}.amr`,
            url: 'https://ptt.example/c2c.silk?rkey=FRESH',
          },
        }],
      },
    });
  });

  it('keeps the self-sent event when the media store cannot index the voice', async () => {
    // `MediaIndexer.remember` runs outside the converter's per-element
    // try/catch on the receive path, where a persistence failure must stay
    // loud. A self-sent echo has no such luxury: losing the event would hide
    // the message the caller just sent, so the indexing failure is contained
    // and reported instead.
    const mediaStore = {
      rememberRecord: vi.fn(() => { throw new Error('cannot store record metadata without an identifier'); }),
    } as unknown as MediaStore;
    const entries: LogEntry[] = [];
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const { ctx, dispatchEvent } = makeContext(RECEIPT, { mediaStore });
    const api = buildApiContext(ctx);

    let result;
    try {
      result = await api.sendPrivateMessage(PEER_ID, [{
        type: 'record',
        data: { file: 'base64://QUNBQ0E=' },
      }], false);
    } finally {
      unsubscribe();
    }

    expect(mediaStore.rememberRecord).toHaveBeenCalledOnce();
    expect(result.messageId).not.toBe(0);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      post_type: 'message_sent',
      message: [expect.objectContaining({
        type: 'record',
        data: { file: '', url: '' },
      })],
    }), 'send');
    expect(entries.some((entry) => (
      entry.scope === 'OneBot'
      && entry.level === 'warn'
      && entry.message.includes('failed to index self-sent media')
    ))).toBe(true);
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
