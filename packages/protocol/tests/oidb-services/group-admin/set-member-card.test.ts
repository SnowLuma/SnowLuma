import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbRenameMember } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetMemberCard } from '../../../src/oidb-services/group-admin/set-member-card';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
  };
}

describe('SetMemberCard namespace', () => {
  it('declares 0x8FC_3', () => {
    expect(SetMemberCard.command).toBe(0x8FC);
    expect(SetMemberCard.subCommand).toBe(3);
  });

  it('routes to 0x8fc_3 with targetUid + targetName', async () => {
    const deps = makeDeps();
    await SetMemberCard.invoke(deps, { groupId: 12345, userId: 67890, card: 'newCard' });
    expect(deps.resolveUserUid).toHaveBeenCalledWith(67890, 12345);
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x8fc_3');
    const env = protobuf_decode<OidbBase<OidbRenameMember>>(bytes);
    expect(env.body).toMatchObject({
      groupUin: 12345,
      body: { targetUid: 'resolved-uid', targetName: 'newCard' },
    });
  });
});
