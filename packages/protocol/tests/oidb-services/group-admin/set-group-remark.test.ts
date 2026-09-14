import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0xf16Req } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetGroupRemark } from '../../../src/oidb-services/group-admin/set-group-remark';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    identity: { uin: '10001', updateGroupRemark: vi.fn(() => true) },
  };
}

describe('SetGroupRemark namespace', () => {
  it('declares 0xF16_1', () => {
    expect(SetGroupRemark.command).toBe(0xF16);
    expect(SetGroupRemark.subCommand).toBe(1);
  });

  it('routes to 0xf16_1 with groupId + remark wrapped in inner', async () => {
    const deps = makeDeps();
    await SetGroupRemark.invoke(deps, { groupId: 12345, remark: 'my group' });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0xf16_1');
    const env = protobuf_decode<OidbBase<Oidb0xf16Req>>(bytes);
    expect(env.body?.inner).toMatchObject({ groupId: 12345n, remark: 'my group' });
  });

  it('updates the local group roster after QQ confirms the remark', async () => {
    const deps = makeDeps();
    await SetGroupRemark.invoke(deps as any, { groupId: 12345, remark: 'my group' });

    expect(deps.identity.updateGroupRemark).toHaveBeenCalledWith(12345, 'my group');
  });

  it('does not update the local roster when QQ rejects the mutation', async () => {
    const deps = makeDeps();
    deps.sendRawPacket.mockResolvedValueOnce({
      success: false,
      gotResponse: true,
      errorCode: 120,
      errorMessage: 'denied',
      responseData: Buffer.alloc(0),
    });

    await expect(
      SetGroupRemark.invoke(deps as any, { groupId: 12345, remark: 'not-applied' }),
    ).rejects.toThrow();
    expect(deps.identity.updateGroupRemark).not.toHaveBeenCalled();
  });
});
