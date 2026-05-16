import type { BridgeInterface } from '../../bridge/bridge-interface';
import type { IdentityService } from '../../bridge/identity-service';
import type { OneBotInstanceContext } from '../instance-context';
import type { JsonObject } from '../types';

export function getLoginInfo(ref: OneBotInstanceContext): { userId: number; nickname: string } {
  const userId = parseInt(ref.uin, 10) || 0;
  const nickname = ref.bridge.identity.nickname || ref.uin;
  return { userId, nickname };
}

// Keep refreshes scoped. A broad "refresh all members in all groups" call can
// turn one OneBot request into N OIDB calls, which is risky for busy clients.
async function refreshSingleGroupMembers(bridge: BridgeInterface, groupId: number): Promise<void> {
  try {
    await bridge.fetchGroupMemberList(groupId);
  } catch {
    // Use cached data.
  }
}

export async function getFriendList(bridge: BridgeInterface): Promise<JsonObject[]> {
  try {
    const friends = await bridge.fetchFriendList();
    return friends.map(f => ({
      user_id: f.uin as any,
      nickname: f.nickname as any,
      remark: f.remark as any,
    }));
  } catch {
    return bridge.identity.friends.map(f => ({
      user_id: f.uin as any,
      nickname: f.nickname as any,
      remark: f.remark as any,
    }));
  }
}

export async function getGroupList(
  bridge: BridgeInterface,
  noCache?: boolean,
): Promise<JsonObject[]> {
  try {
    if (noCache || bridge.identity.groups.length === 0) {
      await bridge.fetchGroupList();
    }
  } catch {
    // Use cached data.
  }
  return bridge.identity.groups.map(g => ({
    group_id: g.groupId as any,
    group_name: g.groupName as any,
    member_count: g.memberCount as any,
    max_member_count: g.memberMax as any,
  }));
}

export async function getGroupInfo(
  bridge: BridgeInterface,
  groupId: number,
  noCache?: boolean,
): Promise<JsonObject | null> {
  if (noCache || !bridge.identity.findGroup(groupId)) {
    try {
      await bridge.fetchGroupList();
    } catch {
      // Use cached data.
    }
  }
  const g = bridge.identity.findGroup(groupId);
  if (!g) return null;
  return {
    group_id: g.groupId as any,
    group_name: g.groupName as any,
    member_count: g.memberCount as any,
    max_member_count: g.memberMax as any,
  };
}

export async function getGroupMemberList(
  bridge: BridgeInterface,
  groupId: number,
  noCache?: boolean,
): Promise<JsonObject[]> {
  if (noCache) {
    await refreshSingleGroupMembers(bridge, groupId);
    return getCachedGroupMembers(bridge.identity, groupId);
  }

  try {
    const members = await bridge.fetchGroupMemberList(groupId);
    return members.map(m => formatGroupMember(groupId, m));
  } catch {
    return getCachedGroupMembers(bridge.identity, groupId);
  }
}

export async function getGroupMemberInfo(
  bridge: BridgeInterface,
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
  bridge: BridgeInterface,
  groupId: number,
  folderId?: string,
): Promise<JsonObject> {
  const result = await bridge.fetchGroupFiles(groupId, folderId ?? '/');
  return {
    files: result.files.map((file) => ({
      group_id: groupId as any,
      file_id: file.fileId as any,
      file_name: file.fileName as any,
      busid: file.busId as any,
      file_size: file.fileSize as any,
      upload_time: file.uploadTime as any,
      dead_time: file.deadTime as any,
      modify_time: file.modifyTime as any,
      download_times: file.downloadTimes as any,
      uploader: file.uploader as any,
      uploader_name: file.uploaderName as any,
    } as JsonObject)) as any,
    folders: result.folders.map((folder) => ({
      group_id: groupId as any,
      folder_id: folder.folderId as any,
      folder_name: folder.folderName as any,
      create_time: folder.createTime as any,
      creator: folder.creator as any,
      create_name: folder.creatorName as any,
      total_file_count: folder.totalFileCount as any,
    } as JsonObject)) as any,
  };
}

export async function getStrangerInfo(
  bridge: BridgeInterface,
  userId: number,
): Promise<JsonObject | null> {
  try {
    const p = await bridge.fetchUserProfile(userId);
    return {
      user_id: p.uin as any,
      nickname: p.nickname as any,
      sex: p.sex as any,
      age: p.age as any,
    };
  } catch {
    const p = bridge.identity.findUserProfile(userId);
    if (!p) return null;
    return {
      user_id: p.uin as any,
      nickname: p.nickname as any,
      sex: p.sex as any,
      age: p.age as any,
    };
  }
}

export async function getGroupSystemMessages(bridge: BridgeInterface): Promise<JsonObject[]> {
  try {
    const reqs = await bridge.fetchGroupRequests();
    return reqs.map(r => ({
      group_id: r.groupId,
      group_name: r.groupName,
      request_id: r.sequence,
      requester_uin: r.targetUin,
      requester_nick: r.targetName,
      message: r.comment,
      flag: `${r.eventType}:${r.groupId}:${r.targetUid}`,
    } as JsonObject));
  } catch {
    return [];
  }
}

export async function getDownloadRKeys(bridge: BridgeInterface): Promise<JsonObject[]> {
  try {
    const rkeys = await bridge.fetchDownloadRKeys();
    return rkeys.map(r => ({
      rkey: r.rkey,
      type: r.type,
      ttl: r.ttlSeconds,
      create_time: r.createTime,
    } as JsonObject));
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
    group_id: groupId as any,
    user_id: member.uin as any,
    nickname: member.nickname as any,
    card: member.card as any,
    sex: 'unknown' as any,
    age: 0 as any,
    join_time: member.joinTime as any,
    last_sent_time: member.lastSentTime as any,
    level: String(member.level) as any,
    role: member.role as any,
    title: member.title as any,
  };
}
