import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbAiVoiceReq, OidbAiVoiceResp } from '@snowluma/proto-defs/oidb-actions/media';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchAiVoice } from '../../../src/oidb-services/extras/fetch-ai-voice';

function makeSender(body?: OidbAiVoiceResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbAiVoiceResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchAiVoice namespace', () => {
  it('declares 0x929B_0', () => {
    expect(FetchAiVoice.command).toBe(0x929B);
    expect(FetchAiVoice.subCommand).toBe(0);
  });

  describe('serialize', () => {
    it('packages every field including sessionId into session sub-message', () => {
      const out = FetchAiVoice.serialize({} as any, {
        groupId: 100, voiceId: 'v', text: 'hi', chatType: 1, sessionId: 0xCAFE,
      });
      expect(out).toEqual({
        groupUin: 100, voiceId: 'v', text: 'hi', chatType: 1,
        session: { sessionId: 0xCAFE },
      });
    });
  });

  describe('deserialize', () => {
    it('returns the first msgInfoBody index when present', () => {
      const node = { fileUuid: 'uuid', subType: 1 };
      expect(FetchAiVoice.deserialize({} as any, {
        msgInfo: { msgInfoBody: [{ index: node }] },
      } as any)).toMatchObject(node);
    });

    it('returns null when msgInfo is empty / missing', () => {
      expect(FetchAiVoice.deserialize({} as any, {} as any)).toBeNull();
      expect(FetchAiVoice.deserialize({} as any, { msgInfo: {} } as any)).toBeNull();
      expect(FetchAiVoice.deserialize({} as any, { msgInfo: { msgInfoBody: [] } } as any)).toBeNull();
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0x929b_0', async () => {
      const sender = makeSender({ msgInfo: { msgInfoBody: [{ index: { fileUuid: 'u' } }] } } as any);
      await FetchAiVoice.invoke(sender, { groupId: 1, voiceId: 'v', text: 't', chatType: 1, sessionId: 1 });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x929b_0');
    });

    it('returns the parsed index node', async () => {
      const node = { fileUuid: 'uuid', subType: 1 };
      const sender = makeSender({ msgInfo: { msgInfoBody: [{ index: node }] } } as any);
      const out = await FetchAiVoice.invoke(sender, { groupId: 1, voiceId: 'v', text: 't', chatType: 1, sessionId: 1 });
      expect(out).toMatchObject(node);
    });

    it('returns null when server polls back empty msgInfo (in-flight)', async () => {
      const sender = makeSender({} as any);
      const out = await FetchAiVoice.invoke(sender, { groupId: 1, voiceId: 'v', text: 't', chatType: 1, sessionId: 1 });
      expect(out).toBeNull();
    });

    it('passes the sessionId through to the wire envelope verbatim', async () => {
      const sender = makeSender({} as any);
      await FetchAiVoice.invoke(sender, { groupId: 1, voiceId: 'v', text: 't', chatType: 1, sessionId: 0xCAFEBABE });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbAiVoiceReq>>(bytes);
      expect(env.body?.session?.sessionId).toBe(0xCAFEBABE);
    });
  });
});
