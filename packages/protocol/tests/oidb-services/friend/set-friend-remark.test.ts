import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbSetFriendRemark } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetFriendRemark } from '../../../src/oidb-services/friend/set-friend-remark';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
  };
}

describe('SetFriendRemark namespace', () => {
  it('declares 0xB6E_2', () => {
    expect(SetFriendRemark.command).toBe(0xB6E);
    expect(SetFriendRemark.subCommand).toBe(2);
  });

  describe('invoke', () => {
    it('routes to OidbSvcTrpcTcp.0xb6e_2', async () => {
      const deps = makeDeps();
      await SetFriendRemark.invoke(deps, { userId: 10001, remark: 'x' });
      expect(deps.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xb6e_2');
    });

    it('resolves the target uid before encoding', async () => {
      const deps = makeDeps();
      await SetFriendRemark.invoke(deps, { userId: 10001, remark: 'best-friend' });
      expect(deps.resolveUserUid).toHaveBeenCalledWith(10001);
    });

    it('packages uid + remark in body', async () => {
      const deps = makeDeps();
      await SetFriendRemark.invoke(deps, { userId: 10001, remark: 'best-friend' });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbSetFriendRemark>>(bytes);
      expect(env.body).toMatchObject({ targetUid: 'resolved-uid', remark: 'best-friend' });
    });
  });
});
