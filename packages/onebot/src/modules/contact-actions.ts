import type { CoreCtx } from '@snowluma/core/core-ctx';
import type { IdentityService } from '@snowluma/protocol/identity-service';
import type { OneBotInstanceContext } from '../instance-context';
import type { JsonObject } from '../types';

export function getLoginInfo(ref: OneBotInstanceContext): { userId: number; nickname: string } {
  const userId = parseInt(ref.uin, 10) || 0;
  const nickname = ref.bridge.identity.nickname || ref.uin;
  return { userId, nickname };
}

async function refreshSingleGroupMembers(bridge: CoreCtx, groupId: number): Promise<void> {
  try {
    await bridge.apis.contacts.fetchGroupMemberList(groupId);
  } catch {
    // 需要打log以便排查问题，但不应当让调用者感知到这个失败。
  }
}

export async function getFriendList(bridge: CoreCtx): Promise<JsonObject[]> {
  try {
    const friends = await bridge.apis.contacts.fetchFriendList();
    return friends.map(f => ({
      user_id: f.uin,
      nickname: f.nickname,
      remark: f.remark,
    }));
  } catch {
    return bridge.identity.friends.map(f => ({
      user_id: f.uin,
      nickname: f.nickname,
      remark: f.remark,
    }));
  }
}

export async function getGroupList(
  bridge: CoreCtx,
  noCache?: boolean,
): Promise<JsonObject[]> {
  try {
    if (noCache || bridge.identity.groups.length === 0) {
      await bridge.apis.contacts.fetchGroupList();
    }
  } catch {
    // Use cached data.
  }
  return bridge.identity.groups.map(g => ({
    group_id: g.groupId,
    group_name: g.groupName,
    member_count: g.memberCount,
    max_member_count: g.memberMax,
  }));
}

export async function getGroupInfo(
  bridge: CoreCtx,
  groupId: number,
  noCache?: boolean,
): Promise<JsonObject | null> {
  if (noCache || !bridge.identity.findGroup(groupId)) {
    try {
      await bridge.apis.contacts.fetchGroupList();
    } catch {
      // Use cached data.
    }
  }
  const g = bridge.identity.findGroup(groupId);
  if (!g) return null;
  return {
    group_id: g.groupId,
    group_name: g.groupName,
    member_count: g.memberCount,
    max_member_count: g.memberMax,
  };
}

export async function getGroupMemberList(
  bridge: CoreCtx,
  groupId: number,
  noCache?: boolean,
): Promise<JsonObject[]> {
  if (noCache) {
    await refreshSingleGroupMembers(bridge, groupId);
    return getCachedGroupMembers(bridge.identity, groupId);
  }

  try {
    const members = await bridge.apis.contacts.fetchGroupMemberList(groupId);
    return members.map(m => formatGroupMember(groupId, m));
  } catch {
    return getCachedGroupMembers(bridge.identity, groupId);
  }
}

export async function getGroupMemberInfo(
  bridge: CoreCtx,
  groupId: number,
  userId: number,
  noCache?: boolean,
): Promise<JsonObject | null> {
  if (noCache || !bridge.identity.findGroupMember(groupId, userId)) {
    await refreshSingleGroupMembers(bridge, groupId);
  }
  const m = bridge.identity.findGroupMember(groupId, userId);
  if (!m) return null;
  return formatGroupMember(groupId, m);
}

export async function getGroupFiles(
  bridge: CoreCtx,
  groupId: number,
  folderId?: string,
): Promise<JsonObject> {
  const result = await bridge.apis.groupFile.list(groupId, folderId ?? '/');
  return {
    files: result.files.map((file) => ({
      group_id: groupId,
      file_id: file.fileId,
      file_name: file.fileName,
      busid: file.busId,
      file_size: file.fileSize,
      upload_time: file.uploadTime,
      dead_time: file.deadTime,
      modify_time: file.modifyTime,
      download_times: file.downloadTimes,
      uploader: file.uploader,
      uploader_name: file.uploaderName,
    } as JsonObject)),
    folders: result.folders.map((folder) => ({
      group_id: groupId,
      folder_id: folder.folderId,
      folder_name: folder.folderName,
      create_time: folder.createTime,
      creator: folder.creator,
      create_name: folder.creatorName,
      total_file_count: folder.totalFileCount,
    } as JsonObject)),
  };
}

export async function getStrangerInfo(
  bridge: CoreCtx,
  userId: number,
): Promise<JsonObject | null> {
  try {
    const p = await bridge.apis.contacts.fetchUserProfile(userId);
    return {
      user_id: p.uin,
      nickname: p.nickname,
      sex: p.sex,
      age: p.age,
      qq_level: p.level,
      level: p.level,
    };
  } catch {
    const p = bridge.identity.findUserProfile(userId);
    if (!p) return null;
    return {
      user_id: p.uin,
      nickname: p.nickname,
      sex: p.sex,
      age: p.age,
      qq_level: p.level,
      level: p.level,
    };
  }
}

export async function getGroupSystemMessages(bridge: CoreCtx): Promise<JsonObject[]> {
  try {
    const reqs = await bridge.apis.contacts.fetchGroupRequests();
    return reqs.map(r => ({
      group_id: r.groupId,
      group_name: r.groupName,
      request_id: r.sequence,
      requester_uin: r.targetUin,
      requester_nick: r.targetName,
      message: r.comment,
      flag: `${r.eventType}:${r.groupId}:${r.targetUid}`,
    }));
  } catch {
    return [];
  }
}

export async function getDownloadRKeys(bridge: CoreCtx): Promise<JsonObject[]> {
  try {
    const rkeys = await bridge.apis.contacts.fetchDownloadRKeys();
    return rkeys.map(r => ({
      rkey: r.rkey,
      type: r.type,
      ttl: r.ttlSeconds,
      create_time: r.createTime,
    }));
  } catch {
    return [];
  }
}

function getCachedGroupMembers(identity: IdentityService, groupId: number): JsonObject[] {
  const g = identity.findGroup(groupId);
  if (!g) return [];
  const result: JsonObject[] = [];
  for (const [, member] of g.members) {
    result.push(formatGroupMember(groupId, member));
  }
  return result;
}

function formatGroupMember(
  groupId: number,
  member: {
    uin: number;
    nickname: string;
    card: string;
    joinTime: number;
    lastSentTime: number;
    level: number;
    role: string;
    title: string;
  },
): JsonObject {
  return {
    group_id: groupId,
    user_id: member.uin,
    nickname: member.nickname,
    card: member.card,
    sex: 'unknown',
    age: 0,
    join_time: member.joinTime,
    last_sent_time: member.lastSentTime,
    level: String(member.level),
    role: member.role,
    title: member.title,
  };
}
