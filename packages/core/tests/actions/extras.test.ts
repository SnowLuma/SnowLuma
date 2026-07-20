import { describe, it, expect } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { QQEventVariant } from '@snowluma/protocol/events';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupTodo,
  OidbStrangerStatusReq,
  OidbStrangerStatusResp,
} from '@snowluma/proto-defs/oidb-actions/base';
import type {
  OidbAiVoiceListReq,
  OidbAiVoiceListResp,
  OidbAiVoiceReq,
  OidbAiVoiceResp,
} from '@snowluma/proto-defs/oidb-actions/media';

// Post-namespace migration: ExtrasApi forwards 6 OIDB cmds through
// namespaces under @snowluma/protocol/oidb-services/extras. Tests assert
// against bridge.sendRawPacket directly.
import { ExtrasApi, AiVoiceChatType } from '../../src/bridge/apis/extras';
import { mockBridge } from './_helpers';

function packResponse(body: Uint8Array) {
  return {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.from(body),
  };
}

describe('apis/extras / group todo (0xF90)', () => {
  it.each([
    ['setGroupTodo', 'OidbSvcTrpcTcp.0xf90_1'] as const,
    ['completeGroupTodo', 'OidbSvcTrpcTcp.0xf90_2'] as const,
    ['cancelGroupTodo', 'OidbSvcTrpcTcp.0xf90_3'] as const,
  ])('%s dispatches the right subCmd with shared body', async (method, cmd) => {
    const bridge = mockBridge();
    const api = new ExtrasApi(bridge as any);
    await (api as any)[method](12345, 9876543210n);
    const [wireName, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(wireName).toBe(cmd);
    const env = protobuf_decode<OidbBase<OidbGroupTodo>>(bytes);
    expect(env.body).toEqual({ groupUin: 12345, msgSeq: 9876543210n });
  });
});

describe('apis/extras / getStrangerStatus (0xFE1_2)', () => {
  it('issues the FE1_2 query with key=27372', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbStrangerStatusResp>>({ body: { data: { status: { value: 5n } } } }),
    ));
    await new ExtrasApi(bridge as any).getStrangerStatus(100200);
    const [wireName, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(wireName).toBe('OidbSvcTrpcTcp.0xfe1_2');
    const env = protobuf_decode<OidbBase<OidbStrangerStatusReq>>(bytes);
    expect(env.command).toBe(0xFE1);
    expect(env.subCommand).toBe(2);
    expect(env.body).toMatchObject({ uin: 100200, key: [{ key: 27372 }] });
  });

  it('low-band values (≤10) map to status*10 with ext_status=0', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbStrangerStatusResp>>({ body: { data: { status: { value: 7n } } } }),
    ));
    expect(await new ExtrasApi(bridge as any).getStrangerStatus(1)).toEqual({ status: 70, ext_status: 0 });
  });

  it('high-band values decompose into the (0xff00 + (>>16 & 0xff)) status word', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbStrangerStatusResp>>({ body: { data: { status: { value: 0x42F100n } } } }),
    ));
    const status = await new ExtrasApi(bridge as any).getStrangerStatus(1);
    expect(status).toEqual({ status: 10, ext_status: 0xF142 });
  });

  it('returns null when the runner throws (transport error)', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockRejectedValueOnce(new Error('boom'));
    expect(await new ExtrasApi(bridge as any).getStrangerStatus(1)).toBeNull();
  });

  it('returns null when the server omits the status field', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbStrangerStatusResp>>({ body: {} }),
    ));
    expect(await new ExtrasApi(bridge as any).getStrangerStatus(1)).toBeNull();
  });
});

describe('apis/extras / AI voice (0x929D / 0x929B)', () => {
  it('fetchAiVoiceList sends 0x929D_0 and returns server content verbatim', async () => {
    const bridge = mockBridge();
    const fake = [
      { category: 'cute', voices: [{ voiceId: 'v1', voiceDisplayName: 'V1', voiceExampleUrl: 'http://x' }] },
    ];
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbAiVoiceListResp>>({ body: { content: fake } } as any),
    ));
    const out = await new ExtrasApi(bridge as any).fetchAiVoiceList(4242, AiVoiceChatType.Sound);
    expect(out).toEqual(fake);
    const [wireName, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(wireName).toBe('OidbSvcTrpcTcp.0x929d_0');
    const env = protobuf_decode<OidbBase<OidbAiVoiceListReq>>(bytes);
    expect(env.body).toEqual({ groupUin: 4242, chatType: 1 });
  });

  it('fetchAiVoiceList returns [] when server replies with no content', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbAiVoiceListResp>>({ body: {} }),
    ));
    const out = await new ExtrasApi(bridge as any).fetchAiVoiceList(1, 1);
    expect(out).toEqual([]);
  });

  it('fetchAiVoice retries while msgInfo is empty and returns the media node', async () => {
    const bridge = mockBridge();
    const node = { fileUuid: 'uuid-1', subType: 1 };
    bridge.sendRawPacket
      .mockResolvedValueOnce(packResponse(protobuf_encode<OidbBase<OidbAiVoiceResp>>({ body: { statusCode: 2 } } as any)))
      .mockResolvedValueOnce(packResponse(protobuf_encode<OidbBase<OidbAiVoiceResp>>({ body: { msgInfo: { msgInfoBody: [] } } as any })))
      .mockResolvedValueOnce(packResponse(protobuf_encode<OidbBase<OidbAiVoiceResp>>({
        body: { field2: 319, field3: 20, msgInfo: { msgInfoBody: [{ index: node }] } } as any,
      })));
    const out = await new ExtrasApi(bridge as any).fetchAiVoice(100, 'voice-id', 'hi', AiVoiceChatType.Sound);
    expect(out).toMatchObject(node);
    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(3);
    const [wireName, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(wireName).toBe('OidbSvcTrpcTcp.0x929b_0');
    const env = protobuf_decode<OidbBase<OidbAiVoiceReq>>(bytes);
    expect(env.body).toMatchObject({
      groupUin: 100, voiceId: 'voice-id', text: 'hi', chatType: 1,
    });
    const sessionId = env.body?.session?.sessionId;
    expect(typeof sessionId).toBe('number');
    expect(sessionId).toBeGreaterThanOrEqual(0);
    expect(sessionId).toBeLessThanOrEqual(0xFFFFFFFF);
  });

  it('fetchAiVoice throws after exhausting the retry budget', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValue(packResponse(
      protobuf_encode<OidbBase<OidbAiVoiceResp>>({ body: { statusCode: 1 } as any }),
    ));
    await expect(new ExtrasApi(bridge as any).fetchAiVoice(1, 'v', 't', 1, 3)).rejects.toThrow(
      /AI voice synthesis did not complete/,
    );
    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(3);
  });

  it('fetchAiVoice keeps the same sessionId across retries', async () => {
    const bridge = mockBridge();
    const node = { fileUuid: 'uuid', subType: 1 };
    bridge.sendRawPacket
      .mockResolvedValueOnce(packResponse(protobuf_encode<OidbBase<OidbAiVoiceResp>>({ body: {} })))
      .mockResolvedValueOnce(packResponse(protobuf_encode<OidbBase<OidbAiVoiceResp>>({ body: { msgInfo: { msgInfoBody: [{ index: node }] } } as any })));
    await new ExtrasApi(bridge as any).fetchAiVoice(1, 'v', 't', 1);
    const env1 = protobuf_decode<OidbBase<OidbAiVoiceReq>>(bridge.sendRawPacket.mock.calls[0]![1]);
    const env2 = protobuf_decode<OidbBase<OidbAiVoiceReq>>(bridge.sendRawPacket.mock.calls[1]![1]);
    expect(env1.body?.session?.sessionId).toBe(env2.body?.session?.sessionId);
  });

  it('sendAiVoice correlates an echo that arrives before the synthesis response', async () => {
    const events = new BridgeEventBus();
    const bridge = mockBridge({ events: events as any });
    const node = { fileUuid: 'voice-uuid', info: { fileHash: 'AABB' } };
    bridge.sendRawPacket.mockImplementationOnce(async () => {
      await events.emit({
        kind: 'group_message',
        time: 1234,
        selfUin: 10001,
        groupId: 100,
        groupName: 'test',
        senderUin: 10001,
        senderNick: 'self',
        senderCard: '',
        senderRole: 'member',
        msgSeq: 319,
        msgId: 456,
        elements: [{ type: 'record', fileId: 'voice-uuid', fileHash: 'AABB' }],
      });
      return packResponse(protobuf_encode<OidbBase<OidbAiVoiceResp>>({
        body: { msgInfo: { msgInfoBody: [{ index: node }] } },
      } as any));
    });

    const receipt = await new ExtrasApi(bridge as any).sendAiVoice(100, 'v', 't', 1, 50);
    expect(receipt).toEqual({ sequence: 319 });
  });

  it('sendAiVoice ignores unrelated self voice messages and matches the media UUID', async () => {
    const events = new BridgeEventBus();
    const bridge = mockBridge({ events: events as any });
    const node = { fileUuid: 'expected-uuid', info: { fileHash: 'aabb' } };
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbAiVoiceResp>>({
        body: { msgInfo: { msgInfoBody: [{ index: node }] } },
      } as any),
    ));
    const pending = new ExtrasApi(bridge as any).sendAiVoice(100, 'v', 't', 1, 100);
    await events.emit({
      kind: 'group_message', time: 0, selfUin: 10001, groupId: 999, groupName: 'other',
      senderUin: 10001, senderNick: 'self', senderCard: '', senderRole: 'member',
      msgSeq: 10, msgId: 20,
      elements: [{ type: 'record', fileId: 'expected-uuid' }],
    });
    await events.emit({
      kind: 'group_message', time: 0, selfUin: 10001, groupId: 100, groupName: 'test',
      senderUin: 20002, senderNick: 'other', senderCard: '', senderRole: 'member',
      msgSeq: 11, msgId: 21,
      elements: [{ type: 'record', fileId: 'expected-uuid' }],
    });
    await events.emit({
      kind: 'group_message', time: 0, selfUin: 10001, groupId: 100, groupName: 'test',
      senderUin: 10001, senderNick: 'self', senderCard: '', senderRole: 'member',
      msgSeq: 12, msgId: 22,
      elements: [{ type: 'text', text: 'not a voice' }],
    });
    await events.emit({
      kind: 'group_message', time: 1, selfUin: 10001, groupId: 100, groupName: 'test',
      senderUin: 10001, senderNick: 'self', senderCard: '', senderRole: 'member',
      msgSeq: 1, msgId: 2,
      elements: [{ type: 'record', fileId: 'EXPECTED-UUID', fileHash: 'AABB' }],
    });
    await events.emit({
      kind: 'group_message', time: 3, selfUin: 10001, groupId: 100, groupName: 'test',
      senderUin: 10001, senderNick: 'self', senderCard: '', senderRole: 'member',
      msgSeq: 4, msgId: 5, elements: [{ type: 'record', mediaNode: { fileUuid: 'expected-uuid' } }],
    });

    await expect(pending).resolves.toEqual({ sequence: 4 });
  });

  it('sendAiVoice lets each self-message receipt satisfy only one concurrent request', async () => {
    const events = new BridgeEventBus();
    const bridge = mockBridge({ events: events as any });
    const node = { fileUuid: 'shared-uuid', info: { fileHash: 'AABB' } };
    bridge.sendRawPacket.mockResolvedValue(packResponse(
      protobuf_encode<OidbBase<OidbAiVoiceResp>>({
        body: { msgInfo: { msgInfoBody: [{ index: node }] } },
      } as any),
    ));
    const api = new ExtrasApi(bridge as any);
    const first = api.sendAiVoice(100, 'v', 'same text', 1, 100);
    const second = api.sendAiVoice(100, 'v', 'same text', 1, 100);

    const firstReceipt: Extract<QQEventVariant, { kind: 'group_message' }> = {
      kind: 'group_message', time: 1, selfUin: 10001, groupId: 100, groupName: 'test',
      senderUin: 10001, senderNick: 'self', senderCard: '', senderRole: 'member',
      msgSeq: 10, msgId: 20, elements: [{ type: 'record', fileId: 'shared-uuid' }],
    };
    await events.emit(firstReceipt);
    // A second QQ process can decode the same push into a different object.
    await events.emit({ ...firstReceipt, elements: [...firstReceipt.elements] });
    await events.emit({
      kind: 'group_message', time: 2, selfUin: 10001, groupId: 100, groupName: 'test',
      senderUin: 10001, senderNick: 'self', senderCard: '', senderRole: 'member',
      msgSeq: 11, msgId: 21, elements: [{ type: 'record', fileId: 'shared-uuid' }],
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { sequence: 10 },
      { sequence: 11 },
    ]);
  });

  it('sendAiVoice fails explicitly when QQ omits every correlation key', async () => {
    const events = new BridgeEventBus();
    const bridge = mockBridge({ events: events as any });
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbAiVoiceResp>>({
        body: { msgInfo: { msgInfoBody: [{ index: { subType: 1 } }] } },
      } as any),
    ));

    await expect(new ExtrasApi(bridge as any).sendAiVoice(100, 'v', 't', 1, 10)).rejects.toThrow(
      /no exact media identifier/i,
    );
  });

  it('sendAiVoice refuses hash-only correlation because concurrent audio can be identical', async () => {
    const events = new BridgeEventBus();
    const bridge = mockBridge({ events: events as any });
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbAiVoiceResp>>({
        body: { msgInfo: { msgInfoBody: [{ index: { info: { fileHash: 'AABB' } } }] } },
      } as any),
    ));

    await expect(new ExtrasApi(bridge as any).sendAiVoice(100, 'v', 't', 1, 10)).rejects.toThrow(
      /no exact media identifier/i,
    );
  });

  it('sendAiVoice rejects a matched receipt with an invalid message sequence', async () => {
    const events = new BridgeEventBus();
    const bridge = mockBridge({ events: events as any });
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbAiVoiceResp>>({
        body: { msgInfo: { msgInfoBody: [{ index: { fileUuid: 'uuid' } }] } },
      } as any),
    ));
    const pending = new ExtrasApi(bridge as any).sendAiVoice(100, 'v', 't', 1, 50);
    await events.emit({
      kind: 'group_message', time: 1, selfUin: 10001, groupId: 100, groupName: 'test',
      senderUin: 10001, senderNick: 'self', senderCard: '', senderRole: 'member',
      msgSeq: 0, msgId: 2, elements: [{ type: 'record', fileId: 'uuid' }],
    });

    await expect(pending).rejects.toThrow(/invalid message sequence: 0/i);
  });

  it('sendAiVoice fails explicitly when the canonical echo never arrives', async () => {
    const events = new BridgeEventBus();
    const bridge = mockBridge({ events: events as any });
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbAiVoiceResp>>({
        body: { msgInfo: { msgInfoBody: [{ index: { fileUuid: 'uuid' } }] } },
      } as any),
    ));

    await expect(new ExtrasApi(bridge as any).sendAiVoice(100, 'v', 't', 1, 5)).rejects.toThrow(
      /published but no matching group-message receipt/i,
    );
  });
});
