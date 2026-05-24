import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbStrangerStatusReq, OidbStrangerStatusResp } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetStrangerStatus } from '../../../src/oidb-services/extras/get-stranger-status';

function makeSender(body?: OidbStrangerStatusResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbStrangerStatusResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetStrangerStatus namespace', () => {
  it('declares 0xFE1_2 with uinForm=true', () => {
    expect(GetStrangerStatus.command).toBe(0xFE1);
    expect(GetStrangerStatus.subCommand).toBe(2);
    expect(GetStrangerStatus.uinForm).toBe(true);
  });

  describe('serialize', () => {
    it('always queries only key 27372 (status property)', () => {
      const out = GetStrangerStatus.serialize({} as any, { uin: 100200 });
      expect(out).toEqual({ uin: 100200, key: [{ key: 27372 }] });
    });
  });

  describe('deserialize', () => {
    it('low-band (≤10) values map to (value*10, 0)', () => {
      expect(GetStrangerStatus.deserialize({} as any, { data: { status: { value: 7n } } })).toEqual({ status: 70, ext_status: 0 });
      expect(GetStrangerStatus.deserialize({} as any, { data: { status: { value: 10n } } })).toEqual({ status: 100, ext_status: 0 });
    });

    it('high-band values decompose into (0xff00 + (>>16 & 0xff)) ext_status', () => {
      // 0x42F100 → bits 8..15 = 0xF1<<8 = 0xF100, bits 16..23 = 0x42 → 0xF142
      expect(GetStrangerStatus.deserialize({} as any, { data: { status: { value: 0x42F100n } } }))
        .toEqual({ status: 10, ext_status: 0xF142 });
    });

    it('returns null when status field is missing', () => {
      expect(GetStrangerStatus.deserialize({} as any, {})).toBeNull();
      expect(GetStrangerStatus.deserialize({} as any, { data: {} })).toBeNull();
      expect(GetStrangerStatus.deserialize({} as any, { data: { status: {} } })).toBeNull();
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0xfe1_2 with uinForm=true (envelope reserved=1)', async () => {
      const sender = makeSender({ data: { status: { value: 5n } } });
      await GetStrangerStatus.invoke(sender, { uin: 100200 });
      const [wireName, bytes] = sender.sendRawPacket.mock.calls[0]!;
      expect(wireName).toBe('OidbSvcTrpcTcp.0xfe1_2');
      const env = protobuf_decode<OidbBase<OidbStrangerStatusReq>>(bytes);
      expect(env.reserved).toBe(1);
    });

    it('returns the decoded status object', async () => {
      const sender = makeSender({ data: { status: { value: 5n } } });
      const out = await GetStrangerStatus.invoke(sender, { uin: 1 });
      expect(out).toEqual({ status: 50, ext_status: 0 });
    });
  });
});
