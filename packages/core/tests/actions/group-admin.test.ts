import { describe, it, expect, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbSvcTrpcTcp0x88D_0Response } from '@snowluma/proto-defs/oidb';
import type { OidbGetGroupExtResp } from '@snowluma/proto-defs/oidb-actions/group-ext';
import type {
  Oidb0x8a0Req,
  Oidb0x8a7Resp,
  Oidb0x89a_0AddOption,
  Oidb0x89a_0Search,
  Oidb0x89a_0InvitePolicy,
  Oidb0x89a_0HistoryVisibility,
  Oidb0x89a_0MemberPermission,
  Oidb0xf16Req,
  OidbGroupRequestAction,
  OidbKickMember,
  OidbLeaveGroup,
  OidbMuteAll,
  OidbMuteMember,
  OidbRenameGroup,
  OidbRenameMember,
  OidbSetAdmin,
  OidbSpecialTitle,
} from '@snowluma/proto-defs/oidb-actions/base';

// Post-namespace migration: GroupAdminApi forwards through namespaces
// under @snowluma/protocol/oidb-services/group-admin. Tests assert
// against bridge.sendRawPacket directly — no module-level mocks.
import { GroupAdminApi } from '../../src/bridge/apis/group-admin';
import { mockBridge } from './_helpers';

function packResponse(body: Uint8Array) {
  return {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.from(body),
  };
}

function packPrivilegeFlag(privilegeFlag?: number) {
  return packResponse(protobuf_encode<OidbBase<OidbSvcTrpcTcp0x88D_0Response>>({
    body: {
      groupInfo: {
        uin: 12345n,
        results: privilegeFlag === undefined ? {} : { privilegeFlag },
      },
    },
  }));
}

function packGroupFlagExt4(groupFlagExt4?: number) {
  return packResponse(protobuf_encode<OidbBase<OidbSvcTrpcTcp0x88D_0Response>>({
    body: {
      groupInfo: {
        uin: 12345n,
        results: groupFlagExt4 === undefined ? {} : { groupFlagExt4 },
      },
    },
  }));
}

function packAdminDetail(results: NonNullable<NonNullable<OidbSvcTrpcTcp0x88D_0Response['groupInfo']>['results']>) {
  return packResponse(protobuf_encode<OidbBase<OidbSvcTrpcTcp0x88D_0Response>>({
    body: { groupInfo: { uin: 12345n, results } },
  }));
}

function packRobotExt(robotMemberSwitch?: number, robotMemberExamine?: number) {
  return packResponse(protobuf_encode<OidbBase<OidbGetGroupExtResp>>({
    body: {
      items: [{
        groupCode: 12345n,
        ext: {
          inviteRobotMemberSwitch: robotMemberSwitch,
          inviteRobotMemberExamine: robotMemberExamine,
        },
      }],
    },
  }));
}

describe('apis/group-admin', () => {
  it('muteMember resolves UID and dispatches 0x1253_1', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).muteMember(12345, 67890, 600);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(67890, 12345);
    const [cmd, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x1253_1');
    const env = protobuf_decode<OidbBase<OidbMuteMember>>(bytes);
    expect(env.command).toBe(0x1253);
    expect(env.subCommand).toBe(1);
    expect(env.body).toMatchObject({
      groupUin: 12345,
      type: 1,
      body: { targetUid: 'resolved-uid', duration: 600 },
    });
  });

  it('muteAll flips the muteState flag based on enable', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).muteAll(12345, true);
    const env1 = protobuf_decode<OidbBase<OidbMuteAll>>(bridge.sendRawPacket.mock.calls[0]![1]);
    expect(env1.body).toMatchObject({ groupUin: 12345, muteState: { state: 0xFFFFFFFF } });

    await new GroupAdminApi(bridge as any).muteAll(12345, false);
    const env2 = protobuf_decode<OidbBase<OidbMuteAll>>(bridge.sendRawPacket.mock.calls[1]![1]);
    // proto3 default 0 fields are omitted on the wire — equivalent to "state=0".
    expect(env2.body?.muteState?.state ?? 0).toBe(0);
  });

  it('kickMember resolves UID per-group and forwards reject + reason', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      Buffer.from('220308b960', 'hex'),
    ));
    await new GroupAdminApi(bridge as any).kickMember(12345, 67890, true, 'bad behaviour');
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(67890, 12345);
    const [cmd, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x8a0_1');
    const env = protobuf_decode<OidbBase<OidbKickMember>>(bytes);
    expect(env.body).toMatchObject({
      groupUin: 12345,
      targetUid: 'resolved-uid',
      rejectAddRequest: true,
      reason: 'bad behaviour',
    });
  });

  it('kickMember rejects a server business error instead of reporting success (#298)', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      Buffer.from(
        '222008b960121be7bea4e4b8bbe697a0e6b395e8a2abe7a7bbe587bae7bea4e8818a',
        'hex',
      ),
    ));

    await expect(
      new GroupAdminApi(bridge as any).kickMember(12345, 67890, false),
    ).rejects.toThrow('群主无法被移出群聊');
  });

  it('kickMembers resolves each UID in parallel', async () => {
    const bridge = mockBridge();
    vi.mocked(bridge.resolveUserUid)
      .mockResolvedValueOnce('uid-a')
      .mockResolvedValueOnce('uid-b');

    await new GroupAdminApi(bridge as any).kickMembers(12345, [11, 22], false);
    expect(bridge.resolveUserUid).toHaveBeenCalledTimes(2);
    const env = protobuf_decode<OidbBase<Oidb0x8a0Req>>(bridge.sendRawPacket.mock.calls[0]![1]);
    expect(env.body?.targetUids).toEqual(['uid-a', 'uid-b']);
    expect(env.body?.rejectAddRequest ?? 0).toBe(0);
  });

  it('kickMembers rejects the same command-level business error', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      Buffer.from(
        '222008b960121be7bea4e4b8bbe697a0e6b395e8a2abe7a7bbe587bae7bea4e8818a',
        'hex',
      ),
    ));

    await expect(
      new GroupAdminApi(bridge as any).kickMembers(12345, [67890], false),
    ).rejects.toThrow('群主无法被移出群聊');
  });

  it('leave sends 0x1097_1, emits a self group_member_leave, and forgets the group (#133)', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).leave(12345);
    const [cmd, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x1097_1');
    const env = protobuf_decode<OidbBase<OidbLeaveGroup>>(bytes);
    expect(env.body).toMatchObject({ groupUin: 12345 });

    // The server never pushes a member-decrease for our own voluntary leave, so
    // the bridge synthesizes it (self user_id/operator_id) and drops the group.
    expect(bridge.events.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'group_member_leave',
      groupId: 12345,
      userUin: 10001,
      operatorUin: 10001,
      leaveType: 'leave',
    }));
    expect(bridge.identity.forgetGroup).toHaveBeenCalledWith(12345);
  });

  it('setAdmin resolves UID and sends 0x1096_1', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).setAdmin(12345, 67890, true);
    const [cmd, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x1096_1');
    const env = protobuf_decode<OidbBase<OidbSetAdmin>>(bytes);
    expect(env.body).toMatchObject({ groupUin: 12345, uid: 'resolved-uid', isAdmin: true });
  });

  it('setCard / setName / setSpecialTitle / setRemark / setAddOption / setSearch dispatch the right command', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).setCard(1, 2, 'newCard');
    await new GroupAdminApi(bridge as any).setName(1, 'newName');
    await new GroupAdminApi(bridge as any).setSpecialTitle(1, 2, 'newTitle');
    await new GroupAdminApi(bridge as any).setRemark(1, 'newRemark');
    await new GroupAdminApi(bridge as any).setAddOption(1, 2);
    await new GroupAdminApi(bridge as any).setSearch(1);

    const cmds = bridge.sendRawPacket.mock.calls.map(call => call[0]);
    expect(cmds).toEqual([
      'OidbSvcTrpcTcp.0x8fc_3',
      'OidbSvcTrpcTcp.0x89a_15',
      'OidbSvcTrpcTcp.0x8fc_2',
      'OidbSvcTrpcTcp.0xf16_1',
      'OidbSvcTrpcTcp.0x89a_0',
      'OidbSvcTrpcTcp.0x89a_0',
    ]);

    const cardEnv = protobuf_decode<OidbBase<OidbRenameMember>>(bridge.sendRawPacket.mock.calls[0]![1]);
    expect(cardEnv.body).toMatchObject({ groupUin: 1, body: { targetUid: 'resolved-uid', targetName: 'newCard' } });

    const nameEnv = protobuf_decode<OidbBase<OidbRenameGroup>>(bridge.sendRawPacket.mock.calls[1]![1]);
    expect(nameEnv.body).toMatchObject({ groupUin: 1, body: { targetName: 'newName' } });

    const titleEnv = protobuf_decode<OidbBase<OidbSpecialTitle>>(bridge.sendRawPacket.mock.calls[2]![1]);
    // expireTime is proto int_32 and preserves the signed -1 sentinel.
    expect(titleEnv.body?.groupUin).toBe(1);
    expect(titleEnv.body?.body?.targetUid).toBe('resolved-uid');
    expect(titleEnv.body?.body?.specialTitle).toBe('newTitle');
    expect(titleEnv.body?.body?.expireTime).toBe(-1);

    const remarkEnv = protobuf_decode<OidbBase<Oidb0xf16Req>>(bridge.sendRawPacket.mock.calls[3]![1]);
    expect(remarkEnv.body?.inner).toMatchObject({ groupId: 1n, remark: 'newRemark' });

    const addOptEnv = protobuf_decode<OidbBase<Oidb0x89a_0AddOption>>(bridge.sendRawPacket.mock.calls[4]![1]);
    expect(addOptEnv.body).toMatchObject({ groupUin: 1n, settings: { addType: 2 } });
    expect(addOptEnv.body?.settings?.groupQuestion ?? undefined).toBeUndefined();

    const searchEnv = protobuf_decode<OidbBase<Oidb0x89a_0Search>>(bridge.sendRawPacket.mock.calls[5]![1]);
    expect(searchEnv.body?.groupUin).toBe(1n);
  });

  it('setAddOption forwards question and answer for type 4', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).setAddOption(12345, 4, 'how', '42');
    const envelope = protobuf_decode<OidbBase<Oidb0x89a_0AddOption>>(
      bridge.sendRawPacket.mock.calls[0]![1],
    );
    expect(envelope.body).toMatchObject({
      groupUin: 12345n,
      settings: { addType: 4, groupQuestion: 'how', groupAnswer: '42' },
    });
  });

  it('setAddRequest picks _1 / _2 based on filtered flag', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).setAddRequest(12345, 5, 1, true, 'ok', false);
    await new GroupAdminApi(bridge as any).setAddRequest(12345, 5, 1, false, 'no', true);

    const cmds = bridge.sendRawPacket.mock.calls.map(call => call[0]);
    expect(cmds).toEqual([
      'OidbSvcTrpcTcp.0x10c8_1',
      'OidbSvcTrpcTcp.0x10c8_2',
    ]);

    const env1 = protobuf_decode<OidbBase<OidbGroupRequestAction>>(bridge.sendRawPacket.mock.calls[0]![1]);
    expect(env1.reserved).toBe(1); // uinForm
    expect(env1.body?.accept).toBe(1);
    expect(env1.body?.body?.message).toBe('ok');

    const env2 = protobuf_decode<OidbBase<OidbGroupRequestAction>>(bridge.sendRawPacket.mock.calls[1]![1]);
    expect(env2.body?.accept).toBe(2);
  });

  it('setMemberInvitePolicy reads, merges, writes, and verifies the privilege flag (#334)', async () => {
    const bridge = mockBridge();
    const currentPrivilegeFlag = 0x86100001;
    const expectedPrivilegeFlag = 0x84000001;
    bridge.sendRawPacket
      .mockResolvedValueOnce(packPrivilegeFlag(currentPrivilegeFlag))
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packPrivilegeFlag(expectedPrivilegeFlag));

    await new GroupAdminApi(bridge as any).setMemberInvitePolicy(12345, 'disabled');

    expect(bridge.sendRawPacket.mock.calls.map((call) => call[0])).toEqual([
      'OidbSvcTrpcTcp.0x88d_0',
      'OidbSvcTrpcTcp.0x89a_0',
      'OidbSvcTrpcTcp.0x88d_0',
    ]);
    const env = protobuf_decode<OidbBase<Oidb0x89a_0InvitePolicy>>(
      bridge.sendRawPacket.mock.calls[1]![1],
    );
    expect(env.body).toMatchObject({
      groupUin: 12345n,
      settings: {
        appPrivilegeFlag: expectedPrivilegeFlag,
        appPrivilegeMask: 0x06100000,
        allowMemberInvite: 0,
      },
    });
  });

  it('setMemberInvitePolicy treats an omitted privilege flag as zero', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket
      .mockResolvedValueOnce(packPrivilegeFlag())
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packPrivilegeFlag(0));

    await new GroupAdminApi(bridge as any).setMemberInvitePolicy(12345, 'require_approval');

    const env = protobuf_decode<OidbBase<Oidb0x89a_0InvitePolicy>>(
      bridge.sendRawPacket.mock.calls[1]![1],
    );
    expect(env.body?.settings).toEqual({
      appPrivilegeFlag: 0,
      appPrivilegeMask: 0x06100000,
      allowMemberInvite: 1,
    });
  });

  it('setMemberInvitePolicy fails when group detail has no results block', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbSvcTrpcTcp0x88D_0Response>>({
        body: { groupInfo: { uin: 12345n } },
      }),
    ));

    await expect(
      new GroupAdminApi(bridge as any).setMemberInvitePolicy(12345, 'require_approval'),
    ).rejects.toThrow(/unable to read group member invite policy before update/);
    expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
  });

  it('setMemberInvitePolicy rejects a successful ack when read-back does not match', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket
      .mockResolvedValueOnce(packPrivilegeFlag(0x80100001))
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packPrivilegeFlag(0x80100001));

    await expect(
      new GroupAdminApi(bridge as any).setMemberInvitePolicy(12345, 'disabled'),
    ).rejects.toThrow(/was not applied/);
    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(3);
  });

  it('setNewMemberHistoryVisibility accepts a 0/1 history-visible read-back (#387)', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packGroupFlagExt4(1));

    await new GroupAdminApi(bridge as any).setNewMemberHistoryVisibility(12345, true);

    expect(bridge.sendRawPacket.mock.calls.map((call) => call[0])).toEqual([
      'OidbSvcTrpcTcp.0x89a_0',
      'OidbSvcTrpcTcp.0x88d_0',
    ]);
    const envelope = protobuf_decode<OidbBase<Oidb0x89a_0HistoryVisibility>>(
      bridge.sendRawPacket.mock.calls[0]![1],
    );
    expect(envelope.body).toMatchObject({
      groupUin: 12345n,
      settings: {
        groupFlagExt4: 0x4,
        groupFlagExt4Mask: 0x4,
      },
    });
  });

  it('setNewMemberHistoryVisibility clears visibility when read-back is the off flag', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packGroupFlagExt4(0));

    await new GroupAdminApi(bridge as any).setNewMemberHistoryVisibility(12345, false);

    const envelope = protobuf_decode<OidbBase<Oidb0x89a_0HistoryVisibility>>(
      bridge.sendRawPacket.mock.calls[0]![1],
    );
    expect(envelope.body?.settings).toEqual({
      groupFlagExt4: 0,
      groupFlagExt4Mask: 0x4,
    });
  });

  it('setNewMemberHistoryVisibility treats an omitted history flag as hidden', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packGroupFlagExt4());

    await new GroupAdminApi(bridge as any).setNewMemberHistoryVisibility(12345, false);
    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(2);
  });

  it('setNewMemberHistoryVisibility fails when group detail has no results block', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packResponse(
        protobuf_encode<OidbBase<OidbSvcTrpcTcp0x88D_0Response>>({
          body: { groupInfo: { uin: 12345n } },
        }),
      ));

    await expect(
      new GroupAdminApi(bridge as any).setNewMemberHistoryVisibility(12345, true),
    ).rejects.toThrow(/unable to read new-member history visibility after update/);
    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(2);
  });

  it('setNewMemberHistoryVisibility rejects an ack when read-back stays hidden', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packGroupFlagExt4(0));

    await expect(
      new GroupAdminApi(bridge as any).setNewMemberHistoryVisibility(12345, true),
    ).rejects.toThrow(/was not applied/);
    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(2);
  });

  it('setMemberPermissions applies supplied switches separately and verifies the combined result (#335)', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket
      .mockResolvedValueOnce(packPrivilegeFlag(0x80018001))
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packPrivilegeFlag(0x80010000));

    await new GroupAdminApi(bridge as any).setMemberPermissions(12345, {
      allowMemberUploadAlbum: true,
      allowMemberTemporarySession: false,
      allowMemberCreateGroup: true,
    });

    expect(bridge.sendRawPacket.mock.calls.map((call) => call[0])).toEqual([
      'OidbSvcTrpcTcp.0x88d_0',
      'OidbSvcTrpcTcp.0x89a_0',
      'OidbSvcTrpcTcp.0x89a_0',
      'OidbSvcTrpcTcp.0x89a_0',
      'OidbSvcTrpcTcp.0x88d_0',
    ]);

    const writes = bridge.sendRawPacket.mock.calls.slice(1, 4).map((call) =>
      protobuf_decode<OidbBase<Oidb0x89a_0MemberPermission>>(call[1]).body?.settings,
    );
    expect(writes).toEqual([
      { appPrivilegeFlag: 0x80018000, appPrivilegeMask: 0x1 },
      { appPrivilegeFlag: 0x80018000, appPrivilegeMask: 0x10000 },
      { appPrivilegeFlag: 0x80010000, appPrivilegeMask: 0x8000 },
    ]);
  });

  it('setMemberPermissions rejects an empty update before reading group state', async () => {
    const bridge = mockBridge();
    await expect(
      new GroupAdminApi(bridge as any).setMemberPermissions(12345, {}),
    ).rejects.toThrow(/at least one member permission/);
    expect(bridge.sendRawPacket).not.toHaveBeenCalled();
  });

  it('setMemberPermissions treats an omitted privilege flag as all-allowed (#388)', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket
      .mockResolvedValueOnce(packPrivilegeFlag())
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packPrivilegeFlag(0));

    await new GroupAdminApi(bridge as any).setMemberPermissions(12345, {
      allowMemberUploadAlbum: true,
    });

    const envelope = protobuf_decode<OidbBase<Oidb0x89a_0MemberPermission>>(
      bridge.sendRawPacket.mock.calls[1]![1],
    );
    expect(envelope.body?.settings).toEqual({
      appPrivilegeFlag: 0,
      appPrivilegeMask: 1,
    });
  });

  it('setMemberPermissions fails when group detail has no results block', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<OidbSvcTrpcTcp0x88D_0Response>>({
        body: { groupInfo: { uin: 12345n } },
      }),
    ));

    await expect(
      new GroupAdminApi(bridge as any).setMemberPermissions(12345, {
        allowMemberUploadAlbum: true,
      }),
    ).rejects.toThrow(/unable to read group member permissions before update/);
    expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
  });

  it('setMemberPermissions rejects an ack when final read-back does not match', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket
      .mockResolvedValueOnce(packPrivilegeFlag(0x80000001))
      .mockResolvedValueOnce(packResponse(Buffer.alloc(0)))
      .mockResolvedValueOnce(packPrivilegeFlag(0x80000001));

    await expect(
      new GroupAdminApi(bridge as any).setMemberPermissions(12345, {
        allowMemberUploadAlbum: true,
      }),
    ).rejects.toThrow(/were not applied/);
    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(3);
  });

  it('getAtAllRemain decodes the response and converts BigInts', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<Oidb0x8a7Resp>>({
        body: { canAtAll: true, groupRemain: 12, uinRemain: 5 } as any,
      }),
    ));
    const out = await new GroupAdminApi(bridge as any).getAtAllRemain(12345);
    expect(out).toEqual({
      can_at_all: true,
      remain_at_all_count_for_group: 12,
      remain_at_all_count_for_uin: 5,
    });
  });

  it('getAdminSettings composes detail and ext-info into setter-aligned fields (#385)', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockImplementation(async (cmd: string) => {
      if (cmd === 'OidbSvcTrpcTcp.0x88d_0') {
        return packAdminDetail({
          addType: 2,
          question: 'how',
          answer: '42',
          privilegeFlag: 0x84018001,
          groupFlagExt4: 1,
          noFingerOpen: 1,
        });
      }
      if (cmd === 'OidbSvcTrpcTcp.0xef0_1') {
        return packRobotExt(1, 2);
      }
      return packResponse(Buffer.alloc(0));
    });

    const out = await new GroupAdminApi(bridge as any).getAdminSettings(12345);
    expect(out).toEqual({
      add_type: 2,
      group_question: 'how',
      group_answer: '42',
      robot_member_switch: 1,
      robot_member_examine: 2,
      member_invite_policy: 'disabled',
      allow_member_upload_album: false,
      allow_member_temporary_session: false,
      allow_member_create_group: false,
      new_member_history_visible: true,
      no_finger_open: 1,
      no_code_finger_open: 0,
    });
    expect(bridge.sendRawPacket.mock.calls.map((call) => call[0]).sort()).toEqual([
      'OidbSvcTrpcTcp.0x88d_0',
      'OidbSvcTrpcTcp.0xef0_1',
    ]);
  });

  it('getAdminSettings treats omitted detail/ext zeros as the default values', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockImplementation(async (cmd: string) => {
      if (cmd === 'OidbSvcTrpcTcp.0x88d_0') {
        return packAdminDetail({});
      }
      if (cmd === 'OidbSvcTrpcTcp.0xef0_1') {
        return packRobotExt();
      }
      return packResponse(Buffer.alloc(0));
    });

    await expect(new GroupAdminApi(bridge as any).getAdminSettings(12345)).resolves.toEqual({
      add_type: 0,
      group_question: '',
      group_answer: '',
      robot_member_switch: 0,
      robot_member_examine: 0,
      member_invite_policy: 'require_approval',
      allow_member_upload_album: true,
      allow_member_temporary_session: true,
      allow_member_create_group: true,
      new_member_history_visible: false,
      no_finger_open: 0,
      no_code_finger_open: 0,
    });
  });

  it('getAdminSettings fails when group detail has no results block', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockImplementation(async (cmd: string) => {
      if (cmd === 'OidbSvcTrpcTcp.0x88d_0') {
        return packResponse(protobuf_encode<OidbBase<OidbSvcTrpcTcp0x88D_0Response>>({
          body: { groupInfo: { uin: 12345n } },
        }));
      }
      return packRobotExt(0, 0);
    });

    await expect(new GroupAdminApi(bridge as any).getAdminSettings(12345))
      .rejects.toThrow(/unable to read group admin settings/);
  });

  it('getAtAllRemain falls back to zero / false when the response is empty', async () => {
    const bridge = mockBridge();
    // Empty OidbBase envelope (no body) — invokeOidb substitutes `{}`
    // for the deserialize argument; canAtAll/groupRemain/uinRemain
    // become undefined and get coerced to false/0.
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<Oidb0x8a7Resp>>({}),
    ));
    const out = await new GroupAdminApi(bridge as any).getAtAllRemain(12345);
    expect(out).toEqual({
      can_at_all: false,
      remain_at_all_count_for_group: 0,
      remain_at_all_count_for_uin: 0,
    });
  });
});
