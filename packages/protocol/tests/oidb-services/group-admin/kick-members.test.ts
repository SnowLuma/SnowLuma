import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x8a0Req } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { KickMembers } from '../../../src/oidb-services/group-admin/kick-members';

function makeDeps(resolveSequence: string[] = ['uid-a', 'uid-b']) {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  const resolveUserUid = vi.fn();
  for (const uid of resolveSequence) resolveUserUid.mockResolvedValueOnce(uid);
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid,
  };
}

describe('KickMembers namespace', () => {
  it('declares 0x8A0_1 (same as KickMember; disambiguated by proto body)', () => {
    expect(KickMembers.command).toBe(0x8A0);
    expect(KickMembers.subCommand).toBe(1);
  });

  it('resolves each uid in parallel and packages targetUids[]', async () => {
    const deps = makeDeps(['uid-a', 'uid-b']);
    await KickMembers.invoke(deps, { groupId: 12345, userIds: [11, 22], reject: false });
    expect(deps.resolveUserUid).toHaveBeenCalledTimes(2);
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x8a0_1');
    const env = protobuf_decode<OidbBase<Oidb0x8a0Req>>(bytes);
    expect(env.body?.targetUids).toEqual(['uid-a', 'uid-b']);
    expect(env.body?.groupId).toBe(12345n);
    expect(env.body?.rejectAddRequest ?? 0).toBe(0);
  });

  it('reject=true => rejectAddRequest=1', async () => {
    const deps = makeDeps(['u']);
    await KickMembers.invoke(deps, { groupId: 1, userIds: [2], reject: true });
    const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<Oidb0x8a0Req>>(bytes);
    expect(env.body?.rejectAddRequest).toBe(1);
  });
});
