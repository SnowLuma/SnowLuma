// Group admin actions: mute/kick/leave/role/profile + join-request approval.
// Every function ultimately routes through one OIDB schema; the function
// names match the OneBot action names (set_group_kick, set_group_ban, ...)
// so callers can grep across the two layers.

import type { Bridge } from '../bridge';
import { sendOidbAndCheck, sendOidbAndDecode, resolveUserUid } from '../bridge-oidb';
import {
  Oidb0x89a_0AddOptionSchema,
  Oidb0x89a_0SearchSchema,
  Oidb0x8a0ReqSchema,
  Oidb0x8a7ReqSchema,
  Oidb0x8a7RespSchema,
  OidbGroupRequestActionSchema,
  OidbKickMemberSchema,
  OidbLeaveGroupSchema,
  OidbMuteAllSchema,
  OidbMuteMemberSchema,
  OidbRenameGroupSchema,
  OidbRenameMemberSchema,
  OidbSetAdminSchema,
  OidbSpecialTitleSchema,
  Oidb0xf16ReqSchema,
} from '../proto/oidb-action';

// ─────────────── mute / un-mute ───────────────

export async function muteGroupMember(bridge: Bridge, groupId: number, userId: number, duration: number): Promise<void> {
  const uid = await resolveUserUid(bridge, userId, groupId);
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x1253_1', 0x1253, 1,
    { groupUin: groupId, type: 1, body: { targetUid: uid, duration } }, OidbMuteMemberSchema);
}

export async function muteGroupAll(bridge: Bridge, groupId: number, enable: boolean): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x89a_0', 0x89A, 0,
    { groupUin: groupId, muteState: { state: enable ? 0xFFFFFFFF : 0 } }, OidbMuteAllSchema);
}

// ─────────────── join-policy ───────────────

export async function setGroupAddOption(bridge: Bridge, groupId: number, addType: number): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x89a_0', 0x89A, 0,
    { groupUin: BigInt(groupId), settings: { addType }, field12: 0 }, Oidb0x89a_0AddOptionSchema);
}

export async function setGroupSearch(bridge: Bridge, groupId: number): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x89a_0', 0x89A, 0,
    { groupUin: BigInt(groupId), settings: new Uint8Array(0), field12: 0 }, Oidb0x89a_0SearchSchema);
}

export async function setGroupAddRequest(
  bridge: Bridge, groupId: number, sequence: number, eventType: number,
  approve: boolean, reason = '', filtered = false,
): Promise<void> {
  const subCmd = filtered ? 2 : 1;
  const cmd = filtered ? 'OidbSvcTrpcTcp.0x10c8_2' : 'OidbSvcTrpcTcp.0x10c8_1';
  await sendOidbAndCheck(bridge, cmd, 0x10C8, subCmd,
    { accept: approve ? 1 : 2, body: { sequence: BigInt(sequence), eventType, groupUin: groupId, message: reason } },
    OidbGroupRequestActionSchema, true);
}

// ─────────────── kick / leave ───────────────

export async function kickGroupMember(bridge: Bridge, groupId: number, userId: number, reject: boolean, reason = ''): Promise<void> {
  const uid = await resolveUserUid(bridge, userId, groupId);
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x8a0_1', 0x8A0, 1,
    { groupUin: groupId, targetUid: uid, rejectAddRequest: reject, reason }, OidbKickMemberSchema);
}

export async function kickGroupMembers(bridge: Bridge, groupId: number, userIds: number[], reject: boolean): Promise<void> {
  const targetUids = await Promise.all(userIds.map(userId => resolveUserUid(bridge, userId, groupId)));
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x8a0_1', 0x8A0, 1,
    { groupId: BigInt(groupId), targetUids, rejectAddRequest: reject ? 1 : 0, kickReason: new Uint8Array(0), field12: 0 }, Oidb0x8a0ReqSchema);
}

export async function leaveGroup(bridge: Bridge, groupId: number): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x1097_1', 0x1097, 1,
    { groupUin: groupId }, OidbLeaveGroupSchema);
}

// ─────────────── role / display name ───────────────

export async function setGroupAdmin(bridge: Bridge, groupId: number, userId: number, enable: boolean): Promise<void> {
  const uid = await resolveUserUid(bridge, userId, groupId);
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x1096_1', 0x1096, 1,
    { groupUin: groupId, uid, isAdmin: enable }, OidbSetAdminSchema);
}

export async function setGroupCard(bridge: Bridge, groupId: number, userId: number, card: string): Promise<void> {
  const uid = await resolveUserUid(bridge, userId, groupId);
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x8fc_3', 0x8FC, 3,
    { groupUin: groupId, body: { targetUid: uid, targetName: card } }, OidbRenameMemberSchema);
}

export async function setGroupName(bridge: Bridge, groupId: number, name: string): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x89a_15', 0x89A, 15,
    { groupUin: groupId, body: { targetName: name } }, OidbRenameGroupSchema);
}

export async function setGroupSpecialTitle(bridge: Bridge, groupId: number, userId: number, title: string): Promise<void> {
  const uid = await resolveUserUid(bridge, userId, groupId);
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x8fc_2', 0x8FC, 2,
    { groupUin: groupId, body: { targetUid: uid, specialTitle: title, expireTime: -1 } }, OidbSpecialTitleSchema);
}

// ─────────────── personal-side metadata ───────────────

// setGroupRemark is the bot's local-only label for the group; it lives
// here rather than in friend.ts because the semantic is "operate on a
// group" rather than "operate on a contact list".
export async function setGroupRemark(bridge: Bridge, groupId: number, remark: string): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0xf16_1', 0xF16, 1,
    { inner: { groupId: BigInt(groupId), remark }, field12: 0 }, Oidb0xf16ReqSchema);
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
    uin: BigInt(bridge.qqInfo.uin),
    groupId: BigInt(groupId),
    type: 0,
  };

  const result = await sendOidbAndDecode<any>(
    bridge,
    'OidbSvcTrpcTcp.0x8a7_0',
    0x8A7,
    0,
    req,
    Oidb0x8a7ReqSchema,
    Oidb0x8a7RespSchema,
  );

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

// ─────────────── group avatar ───────────────

export async function setGroupAvatar(
  bridge: Bridge,
  groupId: number,
  source: string,
): Promise<void> {
  const { loadBinarySource, computeHashes } = await import('../highway/utils');
  const { fetchHighwaySession, uploadHighwayHttp } = await import('../highway/highway-client');
  const { protoEncode } = await import('../../protobuf/decode');
  const { GroupAvatarUploadExtSchema } = await import('../proto/highway');

  const loaded = await loadBinarySource(source, 'group avatar');
  if (!loaded.bytes.length) throw new Error('group avatar file is empty');

  const extend = protoEncode({
    field1: 101,
    groupId: BigInt(groupId),
    field3: new Uint8Array([0x08, 0x01, 0x12, 0x00]),
    field5: 3,
    field6: 0,
  }, GroupAvatarUploadExtSchema);

  const hashes = computeHashes(loaded.bytes);
  const session = await fetchHighwaySession(bridge);

  await uploadHighwayHttp(bridge, session, 3000, loaded.bytes, hashes.md5, extend);
}

