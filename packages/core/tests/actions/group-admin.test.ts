import { describe, it, expect, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0x8a0Req,
  Oidb0x8a7Resp,
  Oidb0x89a_0AddOption,
  Oidb0x89a_0Search,
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
    // expireTime is proto int_32 with -1 sentinel; after wire round-trip the
    // proton decoder surfaces it as the unsigned reinterpretation (-1 ≡ 0xFFFFFFFF).
    expect(titleEnv.body?.groupUin).toBe(1);
    expect(titleEnv.body?.body?.targetUid).toBe('resolved-uid');
    expect(titleEnv.body?.body?.specialTitle).toBe('newTitle');
    expect(titleEnv.body?.body?.expireTime).toBe(0xFFFFFFFF);

    const remarkEnv = protobuf_decode<OidbBase<Oidb0xf16Req>>(bridge.sendRawPacket.mock.calls[3]![1]);
    expect(remarkEnv.body?.inner).toMatchObject({ groupId: 1n, remark: 'newRemark' });

    const addOptEnv = protobuf_decode<OidbBase<Oidb0x89a_0AddOption>>(bridge.sendRawPacket.mock.calls[4]![1]);
    expect(addOptEnv.body).toMatchObject({ groupUin: 1n, settings: { addType: 2 } });

    const searchEnv = protobuf_decode<OidbBase<Oidb0x89a_0Search>>(bridge.sendRawPacket.mock.calls[5]![1]);
    expect(searchEnv.body?.groupUin).toBe(1n);
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
