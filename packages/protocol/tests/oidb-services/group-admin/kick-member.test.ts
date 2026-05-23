import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbKickMember } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { KickMember } from '../../../src/oidb-services/group-admin/kick-member';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
  };
}

describe('KickMember namespace', () => {
  it('declares 0x8A0_1', () => {
    expect(KickMember.command).toBe(0x8A0);
    expect(KickMember.subCommand).toBe(1);
  });

  it('resolves uid per-group and forwards reject + reason', async () => {
    const deps = makeDeps();
    await KickMember.invoke(deps, { groupId: 12345, userId: 67890, reject: true, reason: 'bye' });
    expect(deps.resolveUserUid).toHaveBeenCalledWith(67890, 12345);
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x8a0_1');
    const env = protobuf_decode<OidbBase<OidbKickMember>>(bytes);
    expect(env.body).toMatchObject({
      groupUin: 12345, targetUid: 'resolved-uid', rejectAddRequest: true, reason: 'bye',
    });
  });

  it('defaults reason to empty string', async () => {
    const deps = makeDeps();
    await KickMember.invoke(deps, { groupId: 1, userId: 2, reject: false });
    const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbKickMember>>(bytes);
    expect(env.body?.reason ?? '').toBe('');
    expect(env.body?.rejectAddRequest ?? false).toBe(false);
  });
});
