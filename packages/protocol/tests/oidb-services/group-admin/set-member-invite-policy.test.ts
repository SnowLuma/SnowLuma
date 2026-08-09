import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x89a_0InvitePolicy } from '@snowluma/proto-defs/oidb-actions/base';

import {
  MEMBER_INVITE_PRIVILEGE_MASK,
  mergeMemberInvitePrivilegeFlag,
  SetMemberInvitePolicy,
  type GroupMemberInvitePolicy,
} from '../../../src/oidb-services/group-admin/set-member-invite-policy';

function makeSender() {
  const r: SendPacketResult = {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('SetMemberInvitePolicy namespace', () => {
  it.each<[GroupMemberInvitePolicy, number, number]>([
    ['disabled', 0x04000000, 0],
    ['require_approval', 0, 1],
    ['no_approval', 0x00100000, 1],
    ['no_approval_under_100', 0x02000000, 1],
  ])('maps %s to the verified privilege bits', async (policy, policyBits, allowMemberInvite) => {
    const sender = makeSender();
    const unrelatedBits = 0x80000001;

    await SetMemberInvitePolicy.invoke(sender, {
      groupId: 12345,
      currentPrivilegeFlag: unrelatedBits + 0x06100000,
      policy,
    });

    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x89a_0');
    const env = protobuf_decode<OidbBase<Oidb0x89a_0InvitePolicy>>(bytes);
    expect(env.command).toBe(0x89A);
    expect(env.body?.groupUin).toBe(12345n);
    expect(env.body?.settings).toEqual({
      appPrivilegeFlag: unrelatedBits + policyBits,
      appPrivilegeMask: MEMBER_INVITE_PRIVILEGE_MASK,
      allowMemberInvite,
    });
  });

  it('preserves unrelated bits while replacing only the member-invite mask', () => {
    expect(mergeMemberInvitePrivilegeFlag(0xE7100001, 'require_approval'))
      .toBe(0xE1000001);
  });

  it('keeps explicit zero fields on the wire', async () => {
    const sender = makeSender();
    await SetMemberInvitePolicy.invoke(sender, {
      groupId: 1,
      currentPrivilegeFlag: MEMBER_INVITE_PRIVILEGE_MASK,
      policy: 'require_approval',
    });
    const env = protobuf_decode<OidbBase<Oidb0x89a_0InvitePolicy>>(
      sender.sendRawPacket.mock.calls[0]![1],
    );
    expect(env.body?.settings?.appPrivilegeFlag).toBe(0);
    expect(env.body?.settings?.allowMemberInvite).toBe(1);
  });

  it('rejects an invalid current flag before sending a packet', async () => {
    const sender = makeSender();
    await expect(SetMemberInvitePolicy.invoke(sender, {
      groupId: 1,
      currentPrivilegeFlag: -1,
      policy: 'disabled',
    })).rejects.toThrow(/unsigned 32-bit/);
    expect(sender.sendRawPacket).not.toHaveBeenCalled();
  });
});
