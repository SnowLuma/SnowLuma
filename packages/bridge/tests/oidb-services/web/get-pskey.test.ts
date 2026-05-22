import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGetPskeyReq, OidbGetPskeyResp } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetPskey } from '../../../src/oidb-services/web/get-pskey';

function makeSender(body?: OidbGetPskeyResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGetPskeyResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetPskey namespace', () => {
  it('declares 0x102A_0', () => {
    expect(GetPskey.command).toBe(0x102A);
    expect(GetPskey.subCommand).toBe(0);
  });

  describe('serialize', () => {
    it('passes the domainList through verbatim', () => {
      const out = GetPskey.serialize({ domainList: ['qun.qq.com', 'qzone.qq.com'] });
      expect(out.domainList).toEqual(['qun.qq.com', 'qzone.qq.com']);
    });
  });

  describe('deserialize', () => {
    it('builds a Map from server pskeyItems', () => {
      const { domainPskeyMap } = GetPskey.deserialize({
        pskeyItems: [
          { domain: 'qun.qq.com', pskey: 'pskey-qun' },
          { domain: 'qzone.qq.com', pskey: 'pskey-qzone' },
        ],
      });
      expect(domainPskeyMap.get('qun.qq.com')).toBe('pskey-qun');
      expect(domainPskeyMap.get('qzone.qq.com')).toBe('pskey-qzone');
    });

    it('drops entries with missing domain or pskey', () => {
      const { domainPskeyMap } = GetPskey.deserialize({
        pskeyItems: [
          { domain: 'qun.qq.com', pskey: 'ok' },
          { domain: 'missing-pskey.com' },
          { pskey: 'missing-domain' },
        ] as any,
      });
      expect(domainPskeyMap.size).toBe(1);
      expect(domainPskeyMap.get('qun.qq.com')).toBe('ok');
    });

    it('returns empty Map when pskeyItems is absent', () => {
      const { domainPskeyMap } = GetPskey.deserialize({});
      expect(domainPskeyMap.size).toBe(0);
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0x102a_0', async () => {
      const sender = makeSender({ pskeyItems: [] });
      await GetPskey.invoke(sender, { domainList: ['qq.com'] });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x102a_0');
    });

    it('encodes the domain list into the request body', async () => {
      const sender = makeSender({ pskeyItems: [] });
      await GetPskey.invoke(sender, { domainList: ['qun.qq.com'] });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbGetPskeyReq>>(bytes);
      expect(env.body?.domainList).toEqual(['qun.qq.com']);
    });
  });
});
