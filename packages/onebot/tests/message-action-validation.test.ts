import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';
import type { OneBotInstanceContext } from '../src/instance-context';
import {
  deleteMessage,
  sendGroupMessage,
  sendPrivateMessage,
  setEssenceMessage,
} from '../src/modules/message-actions';
import type { MessageMeta } from '../src/types';

function instanceContext(
  sendGroup: ReturnType<typeof vi.fn>,
  sendPrivate: ReturnType<typeof vi.fn> = vi.fn(),
): OneBotInstanceContext {
  const bridge = {
    apis: { message: { sendGroup, sendPrivate } },
    resolveUserUid: vi.fn(async () => 'u_peer'),
  } as unknown as BridgeInterface;

  return {
    uin: '10001',
    selfId: 10001,
    bridge,
    messageStore: {
      resolveReplySequence: () => 0,
      findEvent: () => null,
      findMeta: () => null,
    } as never,
    cacheMessageMeta: vi.fn(),
    mediaStore: {} as never,
    musicSignUrl: '',
  } as unknown as OneBotInstanceContext;
}

describe('outbound message validation at the Action boundary', () => {
  const sendReceipt = {
    messageId: 1,
    sequence: 100,
    clientSequence: 0,
    random: 1,
    timestamp: 1700000000,
  };

  it('returns BAD_REQUEST and performs no send when a later segment is unknown', async () => {
    const bridgeSend = vi.fn();
    const ref = instanceContext(bridgeSend);
    const api = new ApiHandler({
      sendGroupMessage: (groupId, message, autoEscape) =>
        sendGroupMessage(ref, groupId, message, autoEscape),
    } as ApiActionContext);

    const response = await api.handle('send_group_msg', {
      group_id: 12345,
      message: [
        { type: 'text', data: { text: 'must not be sent' } },
        { type: 'unknown_late_segment', data: {} },
      ],
    });

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 1400,
      wording: expect.stringContaining('unknown message segment type'),
    });
    expect(bridgeSend).not.toHaveBeenCalled();
  });

  it('returns BAD_REQUEST and performs no send for malformed JSON cards', async () => {
    const bridgeSend = vi.fn();
    const ref = instanceContext(bridgeSend);
    const api = new ApiHandler({
      sendGroupMessage: (groupId, message, autoEscape) =>
        sendGroupMessage(ref, groupId, message, autoEscape),
    } as ApiActionContext);

    const response = await api.handle('send_group_msg', {
      group_id: 12345,
      message: [{ type: 'json', data: { data: 'not-json' } }],
    });

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 1400,
      wording: expect.stringContaining('must contain a JSON object'),
    });
    expect(bridgeSend).not.toHaveBeenCalled();
  });

  it('reports the public data field when a JSON segment uses data.text', async () => {
    const bridgeSend = vi.fn();
    const ref = instanceContext(bridgeSend);
    const api = new ApiHandler({
      sendGroupMessage: (groupId, message, autoEscape) =>
        sendGroupMessage(ref, groupId, message, autoEscape),
    } as ApiActionContext);

    const response = await api.handle('send_group_msg', {
      group_id: 12345,
      message: [{
        type: 'json',
        data: { text: '{"app":"com.tencent.contact.lua"}' },
      }],
    });

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 1400,
      wording: 'message segment "json" field "data" must be a non-empty JSON string',
    });
    expect(bridgeSend).not.toHaveBeenCalled();
  });

  it('rejects video mixed with other visible content before sending', async () => {
    const bridgeSend = vi.fn(async () => sendReceipt);
    const ref = instanceContext(bridgeSend);
    const api = new ApiHandler({
      sendGroupMessage: (groupId, message, autoEscape) =>
        sendGroupMessage(ref, groupId, message, autoEscape),
    } as ApiActionContext);

    const response = await api.handle('send_group_msg', {
      group_id: 12345,
      message: [
        { type: 'video', data: { file: 'https://example.com/video.mp4' } },
        { type: 'text', data: { text: 'must not become hidden content' } },
      ],
    });

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 1400,
      wording: expect.stringContaining('video'),
    });
    expect(bridgeSend).not.toHaveBeenCalled();
  });

  it('rejects mixed video content before resolving a later segment', async () => {
    const bridgeSend = vi.fn(async () => sendReceipt);
    const getGroupRecommendArk = vi.fn(async () => '{"app":"contact"}');
    const ref = instanceContext(bridgeSend);
    (ref.bridge.apis as any).contacts = { getGroupRecommendArk };
    const api = new ApiHandler({
      sendGroupMessage: (groupId, message, autoEscape) =>
        sendGroupMessage(ref, groupId, message, autoEscape),
    } as ApiActionContext);

    const response = await api.handle('send_group_msg', {
      group_id: 12345,
      message: [
        { type: 'video', data: { file: 'https://example.com/video.mp4' } },
        { type: 'contact', data: { type: 'group', id: 67890 } },
      ],
    });

    expect(response).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(getGroupRecommendArk).not.toHaveBeenCalled();
    expect(bridgeSend).not.toHaveBeenCalled();
  });

  it('rejects multiple video segments before sending', async () => {
    const bridgeSend = vi.fn(async () => sendReceipt);
    const ref = instanceContext(bridgeSend);
    const api = new ApiHandler({
      sendGroupMessage: (groupId, message, autoEscape) =>
        sendGroupMessage(ref, groupId, message, autoEscape),
    } as ApiActionContext);

    const response = await api.handle('send_group_msg', {
      group_id: 12345,
      message: [
        { type: 'video', data: { file: 'https://example.com/first.mp4' } },
        { type: 'video', data: { file: 'https://example.com/second.mp4' } },
      ],
    });

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 1400,
      wording: expect.stringContaining('video'),
    });
    expect(bridgeSend).not.toHaveBeenCalled();
  });

  it('rejects hidden content after a video in CQ string form', async () => {
    const bridgeSend = vi.fn(async () => sendReceipt);
    const ref = instanceContext(bridgeSend);
    const api = new ApiHandler({
      sendGroupMessage: (groupId, message, autoEscape) =>
        sendGroupMessage(ref, groupId, message, autoEscape),
    } as ApiActionContext);

    const response = await api.handle('send_group_msg', {
      group_id: 12345,
      message: '[CQ:video,file=https://example.com/video.mp4]hidden text',
    });

    expect(response).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(bridgeSend).not.toHaveBeenCalled();
  });

  it('rejects video mixed with private-chat content before sending', async () => {
    const privateSend = vi.fn(async () => sendReceipt);
    const ref = instanceContext(vi.fn(), privateSend);
    const api = new ApiHandler({
      sendPrivateMessage: (userId, message, autoEscape, tempGroupId) =>
        sendPrivateMessage(ref, userId, message, autoEscape, tempGroupId),
    } as ApiActionContext);

    const response = await api.handle('send_private_msg', {
      user_id: 67890,
      message: [
        { type: 'video', data: { file: 'https://example.com/video.mp4' } },
        { type: 'text', data: { text: 'must not become hidden content' } },
      ],
    });

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 1400,
      wording: expect.stringContaining('only segment'),
    });
    expect(privateSend).not.toHaveBeenCalled();
  });

  it('keeps exact empty text placeholders compatible with a single video', async () => {
    const bridgeSend = vi.fn(async () => sendReceipt);
    const ref = instanceContext(bridgeSend);
    const api = new ApiHandler({
      sendGroupMessage: (groupId, message, autoEscape) =>
        sendGroupMessage(ref, groupId, message, autoEscape),
    } as ApiActionContext);

    const response = await api.handle('send_group_msg', {
      group_id: 12345,
      message: [
        { type: 'text', data: { text: '' } },
        { type: 'video', data: { file: 'https://example.com/video.mp4' } },
        { type: 'text', data: { text: '' } },
      ],
    });

    expect(response).toMatchObject({ status: 'ok', retcode: 0 });
    expect(bridgeSend).toHaveBeenCalledOnce();
    expect(bridgeSend.mock.calls[0]?.[1]).toMatchObject([{ type: 'video' }]);
  });
});

describe('server-sequence action validation', () => {
  const localOnlyMeta: MessageMeta = {
    isGroup: true,
    targetId: 12345,
    sequence: 0,
    sequenceAuthoritative: false,
    eventName: 'group_message',
    clientSequence: 0,
    random: 0,
    timestamp: 0,
  };

  it('does not recall a message that has only a local id', async () => {
    const recallGroup = vi.fn();
    const bridge = { apis: { message: { recallGroup } } } as unknown as BridgeInterface;

    await expect(deleteMessage(bridge, localOnlyMeta)).rejects.toThrow('no authoritative QQ sequence');
    expect(recallGroup).not.toHaveBeenCalled();
  });

  it('does not mark a message that has only a local id as essence', async () => {
    const setEssence = vi.fn();
    const bridge = { apis: { interaction: { setEssence } } } as unknown as BridgeInterface;
    const store = { findMeta: () => localOnlyMeta } as any;

    await expect(setEssenceMessage(bridge, store, 1, true)).rejects.toThrow('no authoritative QQ sequence');
    expect(setEssence).not.toHaveBeenCalled();
  });
});
