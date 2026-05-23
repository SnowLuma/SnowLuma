import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x8a7Req, Oidb0x8a7Resp } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetAtAllRemain } from '../../../src/oidb-services/group-admin/get-at-all-remain';

function makeDeps(body?: Oidb0x8a7Resp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<Oidb0x8a7Resp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return {
    sendRawPacket: vi.fn(async () => r),
    identity: { uin: '10001' } as any,
  };
}

describe('GetAtAllRemain namespace', () => {
  it('declares 0x8A7_0', () => {
    expect(GetAtAllRemain.command).toBe(0x8A7);
    expect(GetAtAllRemain.subCommand).toBe(0);
  });

  it('emits the basic{1,2,3}=1,2,1 cookie + bot uin + groupId, routes to 0x8a7_0', async () => {
    const deps = makeDeps({ canAtAll: true, groupRemain: 12, uinRemain: 5 });
    await GetAtAllRemain.invoke(deps, { groupId: 12345 });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x8a7_0');
    const env = protobuf_decode<OidbBase<Oidb0x8a7Req>>(bytes);
    expect(env.body).toMatchObject({
      basic1: 1, basic2: 2, basic3: 1,
      uin: 10001n,
      groupId: 12345n,
    });
  });

  it('decodes canAtAll + groupRemain + uinRemain as plain numbers / boolean', async () => {
    const deps = makeDeps({ canAtAll: true, groupRemain: 12, uinRemain: 5 });
    const out = await GetAtAllRemain.invoke(deps, { groupId: 12345 });
    expect(out).toEqual({
      can_at_all: true,
      remain_at_all_count_for_group: 12,
      remain_at_all_count_for_uin: 5,
    });
  });

  it('falls back to false / 0 when the response body is empty', async () => {
    const deps = makeDeps({} as any);
    const out = await GetAtAllRemain.invoke(deps, { groupId: 1 });
    expect(out).toEqual({
      can_at_all: false,
      remain_at_all_count_for_group: 0,
      remain_at_all_count_for_uin: 0,
    });
  });
});
