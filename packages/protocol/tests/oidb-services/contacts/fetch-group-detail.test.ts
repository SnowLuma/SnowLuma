// 0x88D_0 — fetch a single group's detail by uin (resolves non-member groups,
// e.g. to name a group invite). Verifies the request mask + envelope (reserved=0,
// matching Lagrange's GetGroupInfoService) and the response decode.

import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbSvcTrpcTcp0x88D_0Response } from '@snowluma/proto-defs/oidb';
import type { OidbGroupDetailRequest } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchGroupDetail } from '../../../src/oidb-services/contacts/fetch-group-detail';

function makeSender(body?: OidbSvcTrpcTcp0x88D_0Response) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbSvcTrpcTcp0x88D_0Response>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchGroupDetail namespace', () => {
  it('declares 0x88D_0 with no uinForm (reserved stays 0, per Lagrange)', () => {
    expect(FetchGroupDetail.command).toBe(0x88D);
    expect(FetchGroupDetail.subCommand).toBe(0);
    expect((FetchGroupDetail as { uinForm?: boolean }).uinForm).toBeUndefined();
  });

  describe('serialize', () => {
    it('builds the field1 + uin + request-mask flags', () => {
      const out = FetchGroupDetail.serialize({} as any, { groupUin: 601692726 });
      expect(out.field1).toBe(537099973);
      expect(out.config?.uin).toBe(BigInt(601692726));
      expect(out.config?.flags?.name).toBe('');       // string mask → request the name
      expect(out.config?.flags?.memberCount).toBe(true);
      expect(out.config?.flags?.maxMemberCount).toBe(true);
    });
  });

  describe('deserialize', () => {
    it('passes the response body through', () => {
      const body = { groupInfo: { uin: 1n, results: { name: 'X' } } } as any;
      expect(FetchGroupDetail.deserialize({} as any, body)).toBe(body);
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0x88d_0 and round-trips the uin in the request', async () => {
      const sender = makeSender({ groupInfo: { uin: 601692726n, results: { name: 'g' } } });
      await FetchGroupDetail.invoke(sender, { groupUin: 601692726 });

      const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
      expect(cmd).toBe('OidbSvcTrpcTcp.0x88d_0');
      const env = protobuf_decode<OidbBase<OidbGroupDetailRequest>>(bytes);
      expect(env.command).toBe(0x88D);
      expect(env.subCommand ?? 0).toBe(0); // proto3 omits the 0 default on the wire
      expect(env.reserved ?? 0).toBe(0); // NOT uin-form
      expect(env.body?.config?.uin).toBe(BigInt(601692726));
    });

    it('returns the decoded group detail (name + counts)', async () => {
      const sender = makeSender({
        groupInfo: { uin: 601692726n, results: { name: '测试群', memberCount: 42n, maxMemberCount: 500n } },
      });
      const out = await FetchGroupDetail.invoke(sender, { groupUin: 601692726 });
      expect(out.groupInfo?.results?.name).toBe('测试群');
      expect(out.groupInfo?.results?.memberCount).toBe(42n);
      expect(out.groupInfo?.results?.maxMemberCount).toBe(500n);
    });
  });
});
