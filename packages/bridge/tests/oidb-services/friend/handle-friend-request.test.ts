import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbFriendRequestAction } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { HandleFriendRequest } from '../../../src/oidb-services/friend/handle-friend-request';

function makeDeps(resolvedUid = 'resolved-uid') {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => resolvedUid),
  };
}

describe('HandleFriendRequest namespace', () => {
  it('declares 0xB5D_44', () => {
    expect(HandleFriendRequest.command).toBe(0xB5D);
    expect(HandleFriendRequest.subCommand).toBe(44);
  });

  describe('invoke', () => {
    it('routes to OidbSvcTrpcTcp.0xb5d_44', async () => {
      const deps = makeDeps();
      await HandleFriendRequest.invoke(deps, { uidOrFlag: 'uid', approve: true });
      expect(deps.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xb5d_44');
    });

    it('detects digit-only flag → resolves via resolveUserUid', async () => {
      const deps = makeDeps('resolved-from-uin');
      await HandleFriendRequest.invoke(deps, { uidOrFlag: '10001', approve: true });
      expect(deps.resolveUserUid).toHaveBeenCalledWith(10001);
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbFriendRequestAction>>(bytes);
      expect(env.body?.targetUid).toBe('resolved-from-uin');
    });

    it('passes non-numeric flag through verbatim (no resolveUserUid call)', async () => {
      const deps = makeDeps();
      await HandleFriendRequest.invoke(deps, { uidOrFlag: 'flag-abc', approve: false });
      expect(deps.resolveUserUid).not.toHaveBeenCalled();
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbFriendRequestAction>>(bytes);
      expect(env.body?.targetUid).toBe('flag-abc');
    });

    it('encodes accept=3 when approve=true', async () => {
      const deps = makeDeps();
      await HandleFriendRequest.invoke(deps, { uidOrFlag: 'u', approve: true });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbFriendRequestAction>>(bytes);
      expect(env.body?.accept).toBe(3);
    });

    it('encodes accept=5 when approve=false', async () => {
      const deps = makeDeps();
      await HandleFriendRequest.invoke(deps, { uidOrFlag: 'u', approve: false });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbFriendRequestAction>>(bytes);
      expect(env.body?.accept).toBe(5);
    });
  });
});
