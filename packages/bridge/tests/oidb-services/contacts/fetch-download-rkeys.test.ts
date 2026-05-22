import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2RichMediaReq, NTV2RichMediaResp } from '@snowluma/proto-defs/oidb-actions/media';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchDownloadRkeys } from '../../../src/oidb-services/contacts/fetch-download-rkeys';

function makeSender(body?: NTV2RichMediaResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<NTV2RichMediaResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchDownloadRkeys namespace', () => {
  it('declares 0x9067_202 with uinForm=true', () => {
    expect(FetchDownloadRkeys.command).toBe(0x9067);
    expect(FetchDownloadRkeys.subCommand).toBe(202);
    expect(FetchDownloadRkeys.uinForm).toBe(true);
  });

  describe('serialize', () => {
    it('requests the (private=10, group=20, fallback=2) image scopes', () => {
      const out = FetchDownloadRkeys.serialize({});
      expect(out.downloadRkey?.types).toEqual([10, 20, 2]);
    });

    it('packages the fixed reqHead { common, scene, client }', () => {
      const out = FetchDownloadRkeys.serialize({});
      expect(out.reqHead).toEqual({
        common: { requestId: 1, command: 202 },
        scene: { requestType: 2, businessType: 1, sceneType: 0 },
        client: { agentType: 2 },
      });
    });
  });

  describe('deserialize', () => {
    it('throws when respHead.retCode is non-zero', () => {
      expect(() => FetchDownloadRkeys.deserialize({
        respHead: { retCode: 42, message: 'bad' },
      } as any)).toThrow('bad');
    });

    it('passes through on retCode = 0', () => {
      const body = { respHead: { retCode: 0 }, downloadRkey: { rkeys: [] } };
      expect(FetchDownloadRkeys.deserialize(body as any)).toBe(body);
    });

    it('falls back to a generic message when none is provided', () => {
      expect(() => FetchDownloadRkeys.deserialize({
        respHead: { retCode: 1 },
      } as any)).toThrow('fetch download rkey failed');
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0x9067_202 with reserved=1', async () => {
      const sender = makeSender({ respHead: { retCode: 0 }, downloadRkey: { rkeys: [] } } as any);
      await FetchDownloadRkeys.invoke(sender);
      const [wireName, bytes] = sender.sendRawPacket.mock.calls[0]!;
      expect(wireName).toBe('OidbSvcTrpcTcp.0x9067_202');
      const env = protobuf_decode<OidbBase<NTV2RichMediaReq>>(bytes);
      expect(env.reserved).toBe(1);
    });
  });
});
