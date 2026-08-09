import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x89a_0MemberPermission } from '@snowluma/proto-defs/oidb-actions/base';

import {
  GROUP_MEMBER_PERMISSION_MASKS,
  mergeGroupMemberPermission,
  SetMemberPermission,
  type GroupMemberPermission,
} from '../../../src/oidb-services/group-admin/set-member-permission';

function makeSender() {
  const result: SendPacketResult = {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => result) };
}

describe('SetMemberPermission namespace', () => {
  it.each<[GroupMemberPermission, number]>([
    ['upload_album', 0x1],
    ['temporary_session', 0x10000],
    ['create_group', 0x8000],
  ])('uses the verified deny-bit mask for %s', async (permission, mask) => {
    const sender = makeSender();

    await SetMemberPermission.invoke(sender, {
      groupId: 12345,
      currentPrivilegeFlag: 0x80018001,
      permission,
      allow: true,
    });

    const [command, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(command).toBe('OidbSvcTrpcTcp.0x89a_0');
    const envelope = protobuf_decode<OidbBase<Oidb0x89a_0MemberPermission>>(bytes);
    expect(envelope.body).toMatchObject({
      groupUin: 12345n,
      settings: {
        appPrivilegeFlag: Number(BigInt(0x80018001) & ~BigInt(mask)),
        appPrivilegeMask: mask,
      },
    });
  });

  it('sets a deny bit when a capability is disabled', async () => {
    const sender = makeSender();
    await SetMemberPermission.invoke(sender, {
      groupId: 12345,
      currentPrivilegeFlag: 0x80000000,
      permission: 'temporary_session',
      allow: false,
    });

    const envelope = protobuf_decode<OidbBase<Oidb0x89a_0MemberPermission>>(
      sender.sendRawPacket.mock.calls[0]![1],
    );
    expect(envelope.body?.settings).toEqual({
      appPrivilegeFlag: 0x80010000,
      appPrivilegeMask: GROUP_MEMBER_PERMISSION_MASKS.temporary_session,
    });
  });

  it('preserves unrelated bits while changing only the selected capability', () => {
    expect(mergeGroupMemberPermission(0xF0018001, 'upload_album', true))
      .toBe(0xF0018000);
    expect(mergeGroupMemberPermission(0xF0000000, 'create_group', false))
      .toBe(0xF0008000);
  });

  it('keeps explicit zero fields on the wire', async () => {
    const sender = makeSender();
    await SetMemberPermission.invoke(sender, {
      groupId: 1,
      currentPrivilegeFlag: 1,
      permission: 'upload_album',
      allow: true,
    });

    const envelope = protobuf_decode<OidbBase<Oidb0x89a_0MemberPermission>>(
      sender.sendRawPacket.mock.calls[0]![1],
    );
    expect(envelope.body?.settings?.appPrivilegeFlag).toBe(0);
    expect(envelope.body?.settings?.appPrivilegeMask).toBe(1);
  });

  it('rejects an invalid current flag before sending', async () => {
    const sender = makeSender();
    await expect(SetMemberPermission.invoke(sender, {
      groupId: 1,
      currentPrivilegeFlag: 0x1_0000_0000,
      permission: 'upload_album',
      allow: true,
    })).rejects.toThrow(/unsigned 32-bit/);
    expect(sender.sendRawPacket).not.toHaveBeenCalled();
  });
});
