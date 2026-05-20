import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { Bridge } from '../bridge';
import { makeOidbEnvelope, runOidb } from '../bridge-oidb';
import { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0x89a_0AddOption,
  Oidb0x89a_0Search,
  Oidb0x8a0Req,
  Oidb0x8a7Req,
  Oidb0x8a7Resp,
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

// ─────────────── mute / un-mute ───────────────

export async function muteGroupMember(bridge: Bridge, groupId: number, userId: number, duration: number): Promise<void> {
  const uid = await bridge.resolveUserUid(userId, groupId);
  const env = makeOidbEnvelope<OidbMuteMember>(0x1253, 1, {
    groupUin: groupId, type: 1, body: { targetUid: uid, duration },
  });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0x1253_1', protobuf_encode<OidbBase<OidbMuteMember>>(env));
}

export async function muteGroupAll(bridge: Bridge, groupId: number, enable: boolean): Promise<void> {
  const env = makeOidbEnvelope<OidbMuteAll>(0x89A, 0, {
    groupUin: groupId, muteState: { state: enable ? 0xFFFFFFFF : 0 },
  });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0x89a_0', protobuf_encode<OidbBase<OidbMuteAll>>(env));
}

// ─────────────── join-policy ───────────────

export async function setGroupAddOption(bridge: Bridge, groupId: number, addType: number): Promise<void> {
  const env = makeOidbEnvelope<Oidb0x89a_0AddOption>(0x89A, 0, {
    groupUin: BigInt(groupId), settings: { addType }, field12: 0,
  });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0x89a_0', protobuf_encode<OidbBase<Oidb0x89a_0AddOption>>(env));
}

export async function setGroupSearch(bridge: Bridge, groupId: number): Promise<void> {
  const env = makeOidbEnvelope<Oidb0x89a_0Search>(0x89A, 0, {
    groupUin: BigInt(groupId), settings: new Uint8Array(0), field12: 0,
  });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0x89a_0', protobuf_encode<OidbBase<Oidb0x89a_0Search>>(env));
}

export async function setGroupAddRequest(
  bridge: Bridge, groupId: number, sequence: number, eventType: number,
  approve: boolean, reason = '', filtered = false,
): Promise<void> {
  const subCmd = filtered ? 2 : 1;
  const cmd = filtered ? 'OidbSvcTrpcTcp.0x10c8_2' : 'OidbSvcTrpcTcp.0x10c8_1';
  const env = makeOidbEnvelope<OidbGroupRequestAction>(
    0x10C8, subCmd,
    { accept: approve ? 1 : 2, body: { sequence: BigInt(sequence), eventType, groupUin: groupId, message: reason } },
    true,
  );
  await runOidb(bridge, cmd, protobuf_encode<OidbBase<OidbGroupRequestAction>>(env));
}

// ─────────────── kick / leave ───────────────

export async function kickGroupMember(bridge: Bridge, groupId: number, userId: number, reject: boolean, reason = ''): Promise<void> {
  const uid = await bridge.resolveUserUid(userId, groupId);
  const env = makeOidbEnvelope<OidbKickMember>(0x8A0, 1, {
    groupUin: groupId, targetUid: uid, rejectAddRequest: reject, reason,
  });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0x8a0_1', protobuf_encode<OidbBase<OidbKickMember>>(env));
}

export async function kickGroupMembers(bridge: Bridge, groupId: number, userIds: number[], reject: boolean): Promise<void> {
  const targetUids = await Promise.all(userIds.map(userId => bridge.resolveUserUid(userId, groupId)));
  const env = makeOidbEnvelope<Oidb0x8a0Req>(0x8A0, 1, {
    groupId: BigInt(groupId), targetUids, rejectAddRequest: reject ? 1 : 0, kickReason: new Uint8Array(0), field12: 0,
  });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0x8a0_1', protobuf_encode<OidbBase<Oidb0x8a0Req>>(env));
}

export async function leaveGroup(bridge: Bridge, groupId: number): Promise<void> {
  const env = makeOidbEnvelope<OidbLeaveGroup>(0x1097, 1, { groupUin: groupId });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0x1097_1', protobuf_encode<OidbBase<OidbLeaveGroup>>(env));
}

// ─────────────── role / display name ───────────────

export async function setGroupAdmin(bridge: Bridge, groupId: number, userId: number, enable: boolean): Promise<void> {
  const uid = await bridge.resolveUserUid(userId, groupId);
  const env = makeOidbEnvelope<OidbSetAdmin>(0x1096, 1, { groupUin: groupId, uid, isAdmin: enable });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0x1096_1', protobuf_encode<OidbBase<OidbSetAdmin>>(env));
}

export async function setGroupCard(bridge: Bridge, groupId: number, userId: number, card: string): Promise<void> {
  const uid = await bridge.resolveUserUid(userId, groupId);
  const env = makeOidbEnvelope<OidbRenameMember>(0x8FC, 3, {
    groupUin: groupId, body: { targetUid: uid, targetName: card },
  });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0x8fc_3', protobuf_encode<OidbBase<OidbRenameMember>>(env));
}

export async function setGroupName(bridge: Bridge, groupId: number, name: string): Promise<void> {
  const env = makeOidbEnvelope<OidbRenameGroup>(0x89A, 15, { groupUin: groupId, body: { targetName: name } });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0x89a_15', protobuf_encode<OidbBase<OidbRenameGroup>>(env));
}

export async function setGroupSpecialTitle(bridge: Bridge, groupId: number, userId: number, title: string): Promise<void> {
  const uid = await bridge.resolveUserUid(userId, groupId);
  const env = makeOidbEnvelope<OidbSpecialTitle>(0x8FC, 2, {
    groupUin: groupId, body: { targetUid: uid, specialTitle: title, expireTime: -1 },
  });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0x8fc_2', protobuf_encode<OidbBase<OidbSpecialTitle>>(env));
}

// ─────────────── personal-side metadata ───────────────

// setGroupRemark is the bot's local-only label for the group; it lives
// here rather than in friend.ts because the semantic is "operate on a
// group" rather than "operate on a contact list".
export async function setGroupRemark(bridge: Bridge, groupId: number, remark: string): Promise<void> {
  const env = makeOidbEnvelope<Oidb0xf16Req>(0xF16, 1, { inner: { groupId: BigInt(groupId), remark }, field12: 0 });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0xf16_1', protobuf_encode<OidbBase<Oidb0xf16Req>>(env));
}

// ─────────────── group-level quota query ───────────────

export async function getGroupAtAllRemain(
  bridge: Bridge,
  groupId: number,
) {
  const req = {
    basic1: 1,
    basic2: 2,
    basic3: 1,
    uin: BigInt(bridge.identity.uin),
    groupId: BigInt(groupId),
    type: 0,
  };

  const env = makeOidbEnvelope<Oidb0x8a7Req>(0x8A7, 0, req);
  const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x8a7_0', protobuf_encode<OidbBase<Oidb0x8a7Req>>(env));
  const result = protobuf_decode<OidbBase<Oidb0x8a7Resp>>(respBytes).body;

  if (!result) {
    throw new Error('get group at all remain result empty');
  }

  // Cast numbers to plain Number: the OIDB layer may surface uint32 as
  // BigInt and the WebUI JSON serializer chokes on those.
  return {
    can_at_all: !!result.canAtAll,
    remain_at_all_count_for_group: Number(result.groupRemain || 0),
    remain_at_all_count_for_uin: Number(result.uinRemain || 0),
  };
}
