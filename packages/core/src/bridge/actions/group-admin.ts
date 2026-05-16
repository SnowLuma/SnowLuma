// Group admin actions: mute/kick/leave/role/profile + join-request approval.
// Every function ultimately routes through one OIDB schema; the function
// names match the OneBot action names (set_group_kick, set_group_ban, ...)
// so callers can grep across the two layers.

import type { Bridge } from '../bridge';
import { runOidb } from '../bridge-oidb';
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
  const uid = await bridge.resolveUserUid(userId, groupId);
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x1253_1',
    oidbCmd: 0x1253, subCmd: 1,
    request: {
      schema: OidbMuteMemberSchema,
      value: { groupUin: groupId, type: 1, body: { targetUid: uid, duration } },
    },
  });
}

export async function muteGroupAll(bridge: Bridge, groupId: number, enable: boolean): Promise<void> {
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x89a_0',
    oidbCmd: 0x89A, subCmd: 0,
    request: {
      schema: OidbMuteAllSchema,
      value: { groupUin: groupId, muteState: { state: enable ? 0xFFFFFFFF : 0 } },
    },
  });
}

// ─────────────── join-policy ───────────────

export async function setGroupAddOption(bridge: Bridge, groupId: number, addType: number): Promise<void> {
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x89a_0',
    oidbCmd: 0x89A, subCmd: 0,
    request: {
      schema: Oidb0x89a_0AddOptionSchema,
      value: { groupUin: BigInt(groupId), settings: { addType }, field12: 0 },
    },
  });
}

export async function setGroupSearch(bridge: Bridge, groupId: number): Promise<void> {
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x89a_0',
    oidbCmd: 0x89A, subCmd: 0,
    request: {
      schema: Oidb0x89a_0SearchSchema,
      value: { groupUin: BigInt(groupId), settings: new Uint8Array(0), field12: 0 },
    },
  });
}

export async function setGroupAddRequest(
  bridge: Bridge, groupId: number, sequence: number, eventType: number,
  approve: boolean, reason = '', filtered = false,
): Promise<void> {
  const subCmd = filtered ? 2 : 1;
  const cmd = filtered ? 'OidbSvcTrpcTcp.0x10c8_2' : 'OidbSvcTrpcTcp.0x10c8_1';
  await runOidb(bridge, {
    cmd,
    oidbCmd: 0x10C8, subCmd,
    request: {
      schema: OidbGroupRequestActionSchema,
      value: { accept: approve ? 1 : 2, body: { sequence: BigInt(sequence), eventType, groupUin: groupId, message: reason } },
      isUid: true,
    },
  });
}

// ─────────────── kick / leave ───────────────

export async function kickGroupMember(bridge: Bridge, groupId: number, userId: number, reject: boolean, reason = ''): Promise<void> {
  const uid = await bridge.resolveUserUid(userId, groupId);
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x8a0_1',
    oidbCmd: 0x8A0, subCmd: 1,
    request: {
      schema: OidbKickMemberSchema,
      value: { groupUin: groupId, targetUid: uid, rejectAddRequest: reject, reason },
    },
  });
}

export async function kickGroupMembers(bridge: Bridge, groupId: number, userIds: number[], reject: boolean): Promise<void> {
  const targetUids = await Promise.all(userIds.map(userId => bridge.resolveUserUid(userId, groupId)));
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x8a0_1',
    oidbCmd: 0x8A0, subCmd: 1,
    request: {
      schema: Oidb0x8a0ReqSchema,
      value: { groupId: BigInt(groupId), targetUids, rejectAddRequest: reject ? 1 : 0, kickReason: new Uint8Array(0), field12: 0 },
    },
  });
}

export async function leaveGroup(bridge: Bridge, groupId: number): Promise<void> {
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x1097_1',
    oidbCmd: 0x1097, subCmd: 1,
    request: { schema: OidbLeaveGroupSchema, value: { groupUin: groupId } },
  });
}

// ─────────────── role / display name ───────────────

export async function setGroupAdmin(bridge: Bridge, groupId: number, userId: number, enable: boolean): Promise<void> {
  const uid = await bridge.resolveUserUid(userId, groupId);
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x1096_1',
    oidbCmd: 0x1096, subCmd: 1,
    request: { schema: OidbSetAdminSchema, value: { groupUin: groupId, uid, isAdmin: enable } },
  });
}

export async function setGroupCard(bridge: Bridge, groupId: number, userId: number, card: string): Promise<void> {
  const uid = await bridge.resolveUserUid(userId, groupId);
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x8fc_3',
    oidbCmd: 0x8FC, subCmd: 3,
    request: {
      schema: OidbRenameMemberSchema,
      value: { groupUin: groupId, body: { targetUid: uid, targetName: card } },
    },
  });
}

export async function setGroupName(bridge: Bridge, groupId: number, name: string): Promise<void> {
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x89a_15',
    oidbCmd: 0x89A, subCmd: 15,
    request: { schema: OidbRenameGroupSchema, value: { groupUin: groupId, body: { targetName: name } } },
  });
}

export async function setGroupSpecialTitle(bridge: Bridge, groupId: number, userId: number, title: string): Promise<void> {
  const uid = await bridge.resolveUserUid(userId, groupId);
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x8fc_2',
    oidbCmd: 0x8FC, subCmd: 2,
    request: {
      schema: OidbSpecialTitleSchema,
      value: { groupUin: groupId, body: { targetUid: uid, specialTitle: title, expireTime: -1 } },
    },
  });
}

// ─────────────── personal-side metadata ───────────────

// setGroupRemark is the bot's local-only label for the group; it lives
// here rather than in friend.ts because the semantic is "operate on a
// group" rather than "operate on a contact list".
export async function setGroupRemark(bridge: Bridge, groupId: number, remark: string): Promise<void> {
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xf16_1',
    oidbCmd: 0xF16, subCmd: 1,
    request: { schema: Oidb0xf16ReqSchema, value: { inner: { groupId: BigInt(groupId), remark }, field12: 0 } },
  });
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

  const result = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x8a7_0',
    oidbCmd: 0x8A7, subCmd: 0,
    request: { schema: Oidb0x8a7ReqSchema, value: req },
    response: { schema: Oidb0x8a7RespSchema },
  });

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

