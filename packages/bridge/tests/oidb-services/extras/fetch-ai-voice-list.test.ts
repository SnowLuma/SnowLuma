import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbAiVoiceListReq, OidbAiVoiceListResp } from '@snowluma/proto-defs/oidb-actions/media';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchAiVoiceList } from '../../../src/oidb-services/extras/fetch-ai-voice-list';

function makeSender(body?: OidbAiVoiceListResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbAiVoiceListResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchAiVoiceList namespace', () => {
  it('declares 0x929D_0', () => {
    expect(FetchAiVoiceList.command).toBe(0x929D);
    expect(FetchAiVoiceList.subCommand).toBe(0);
  });

  describe('serialize', () => {
    it('passes groupUin / chatType verbatim', () => {
      expect(FetchAiVoiceList.serialize({ groupId: 4242, chatType: 1 })).toEqual({
        groupUin: 4242, chatType: 1,
      });
    });
  });

  describe('deserialize', () => {
    it('returns content array verbatim', () => {
      const out = FetchAiVoiceList.deserialize({
        content: [
          { category: 'cute', voices: [{ voiceId: 'v1', voiceDisplayName: 'V1', voiceExampleUrl: 'http://x' }] },
        ],
      });
      expect(out).toEqual([
        { category: 'cute', voices: [{ voiceId: 'v1', voiceDisplayName: 'V1', voiceExampleUrl: 'http://x' }] },
      ]);
    });

    it('returns [] when content is omitted', () => {
      expect(FetchAiVoiceList.deserialize({})).toEqual([]);
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0x929d_0', async () => {
      const sender = makeSender({ content: [] });
      await FetchAiVoiceList.invoke(sender, { groupId: 100, chatType: 1 });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x929d_0');
    });

    it('encodes envelope body correctly', async () => {
      const sender = makeSender({ content: [] });
      await FetchAiVoiceList.invoke(sender, { groupId: 4242, chatType: 2 });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbAiVoiceListReq>>(bytes);
      expect(env.body).toMatchObject({ groupUin: 4242, chatType: 2 });
    });
  });
});
