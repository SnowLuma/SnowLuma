import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbDeleteFriend } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { DeleteFriend } from '../../../src/oidb-services/friend/delete-friend';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
  };
}

describe('DeleteFriend namespace', () => {
  it('declares 0x126B_0', () => {
    expect(DeleteFriend.command).toBe(0x126B);
    expect(DeleteFriend.subCommand).toBe(0);
  });

  describe('invoke', () => {
    it('routes to OidbSvcTrpcTcp.0x126b_0', async () => {
      const deps = makeDeps();
      await DeleteFriend.invoke(deps, { userId: 10001 });
      expect(deps.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x126b_0');
    });

    it('resolves the target uid before encoding', async () => {
      const deps = makeDeps();
      await DeleteFriend.invoke(deps, { userId: 10001 });
      expect(deps.resolveUserUid).toHaveBeenCalledWith(10001);
    });

    it('packages the nested envelope with verbatim magic constants', async () => {
      const deps = makeDeps();
      await DeleteFriend.invoke(deps, { userId: 10001, block: true });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbDeleteFriend>>(bytes);
      expect(env.body?.field1).toMatchObject({
        targetUid: 'resolved-uid',
        block: true,
        field2: {
          field1: 130,
          field2: 109,
          field3: { field1: 8, field2: 8, field3: 50 },
        },
      });
    });

    it('defaults block to false (no block flag)', async () => {
      const deps = makeDeps();
      await DeleteFriend.invoke(deps, { userId: 10001 });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbDeleteFriend>>(bytes);
      // proto3 false omitted on wire — decoded as null/undefined.
      expect(env.body?.field1?.block ?? false).toBe(false);
    });
  });
});
