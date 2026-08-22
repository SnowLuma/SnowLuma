import { mapWithConcurrency } from '@snowluma/common/concurrency';
import { createLogger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { IdentityService } from '@snowluma/protocol/identity-service';
import {
  formatGroupRequestFlag,
  type GroupMemberInfo,
  type GroupRequestInfo,
  type UserProfileInfo,
} from '@snowluma/protocol/qq-info';
import type { OneBotInstanceContext } from '../instance-context';
import type { JsonObject } from '../types';

const REQUESTER_PROFILE_CONCURRENCY = 4;
const log = createLogger('OneBot.Contacts');

export interface GroupSystemMessageQuery {
  groupId?: number;
  onlyPending?: boolean;
  /** Maximum records read from each QQ request inbox. */
  count?: number;
}

export function getLoginInfo(ref: OneBotInstanceContext): { userId: number; nickname: string } {
  const userId = parseInt(ref.uin, 10) || 0;
  const nickname = ref.bridge.identity.nickname || ref.uin;
  return { userId, nickname };
}

async function fetchSingleGroupMembers(
  bridge: BridgeInterface,
  groupId: number,
  force = false,
): Promise<GroupMemberInfo[]> {
  try {
    return await bridge.apis.contacts.fetchGroupMemberList(groupId, { force });
  } catch (err) {
    log.warn(
      'group member refresh failed: uin=%s group=%d err=%s',
      bridge.identity.uin,
      groupId,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    throw err;
  }
}

export async function getFriendList(bridge: BridgeInterface): Promise<JsonObject[]> {
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
  bridge: BridgeInterface,
  noCache?: boolean,
): Promise<JsonObject[]> {
  try {
    if (noCache || bridge.identity.groups.length === 0) {
      await bridge.apis.contacts.fetchGroupList();
    }
  } catch (err) {
    if (noCache) throw err;
    log.warn(
      'group list refresh failed, using cached roster: uin=%s err=%s',
      bridge.identity.uin,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
  }
  return bridge.identity.groups.map(g => ({
    group_id: g.groupId,
    group_name: g.groupName,
    group_remark: g.remark,
    member_count: g.memberCount,
    max_member_count: g.memberMax,
    // #197: create_time + memo come free from the list; group_level is only in
    // the per-group 0x88D_0 detail, so it stays 0 here (a per-group fetch across
    // the whole list would be far too expensive). get_group_info fills it in.
    group_create_time: g.createTime ?? 0,
    group_level: g.level ?? 0,
    group_memo: g.memo ?? '',
    group_all_shut: g.allMuted ? -1 : 0,
  }));
}

// group_level lives only in the per-group detail response. Keep its existing
// short cache, but read mutable group state from the roster refreshed above.
const GROUP_LEVEL_TTL_MS = 5 * 60 * 1000;
const groupLevelCache = new Map<number, { level: number; at: number }>();
async function getGroupLevel(
  bridge: BridgeInterface,
  groupId: number,
  noCache?: boolean,
): Promise<number> {
  if (!noCache) {
    const cached = groupLevelCache.get(groupId);
    if (cached && Date.now() - cached.at < GROUP_LEVEL_TTL_MS) return cached.level;
  }
  try {
    const detail = await bridge.apis.contacts.fetchGroupDetail(groupId);
    const level = detail?.level ?? 0;
    groupLevelCache.set(groupId, { level, at: Date.now() });
    return level;
  } catch (err) {
    if (noCache) throw err;
    log.warn(
      'group detail refresh failed, using roster metadata: uin=%s group=%d err=%s',
      bridge.identity.uin,
      groupId,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    return 0;
  }
}

// Short-TTL cache for the non-member group lookup (0x88D_0). Joined groups come
// from the identity roster (kept fresh by fetchGroupList) and are NOT cached
// here; this only memoizes the per-id server query so a burst of invites for the
// same group doesn't hammer 0x88D_0 (which would risk a rate-limit / kick).
const NON_MEMBER_GROUP_TTL_MS = 5 * 60 * 1000;
const nonMemberGroupCache = new Map<string, { info: JsonObject; at: number }>();

function nonMemberGroupCacheKey(bridge: BridgeInterface, groupId: number): string {
  return `${bridge.identity.uin}:${groupId}`;
}

export async function getGroupInfo(
  bridge: BridgeInterface,
  groupId: number,
  noCache?: boolean,
): Promise<JsonObject | null> {
  if (noCache || !bridge.identity.findGroup(groupId)) {
    try {
      await bridge.apis.contacts.fetchGroupList();
    } catch (err) {
      if (noCache) throw err;
      log.warn(
        'group list refresh failed, using cached roster: uin=%s group=%d err=%s',
        bridge.identity.uin,
        groupId,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    }
  }
  const g = bridge.identity.findGroup(groupId);
  if (g) {
    return {
      group_id: g.groupId,
      group_name: g.groupName,
      group_remark: g.remark,
      member_count: g.memberCount,
      max_member_count: g.memberMax,
      group_create_time: g.createTime ?? 0,
      group_level: await getGroupLevel(bridge, groupId, noCache),
      group_memo: g.memo ?? '',
      group_all_shut: g.allMuted ? -1 : 0,
    };
  }

  // Not a joined group — fall back to the by-id server lookup so a group invite
  // can still resolve its name. Cached with a short TTL (skipped when noCache).
  const cacheKey = nonMemberGroupCacheKey(bridge, groupId);
  if (!noCache) {
    const cached = nonMemberGroupCache.get(cacheKey);
    if (cached && Date.now() - cached.at < NON_MEMBER_GROUP_TTL_MS) return { ...cached.info };
  }
  try {
    const detail = await bridge.apis.contacts.fetchGroupDetail(groupId);
    if (detail) {
      const info: JsonObject = {
        group_id: detail.groupId,
        group_name: detail.groupName,
        group_remark: detail.remark,
        member_count: detail.memberCount,
        max_member_count: detail.memberMax,
        group_create_time: detail.createTime ?? 0,
        group_level: detail.level ?? 0,
        group_memo: detail.memo ?? '',
        group_all_shut: detail.allMuted ? -1 : 0,
      };
      nonMemberGroupCache.set(cacheKey, { info, at: Date.now() });
      return { ...info };
    }
  } catch (err) {
    if (noCache) throw err;
    log.warn(
      'non-member group lookup failed: uin=%s group=%d err=%s',
      bridge.identity.uin,
      groupId,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
  }
  return null;
}

export async function getGroupMemberList(
  bridge: BridgeInterface,
  groupId: number,
  noCache?: boolean,
): Promise<JsonObject[]> {
  if (noCache) {
    const members = await fetchSingleGroupMembers(bridge, groupId, true);
    return members.map(m => formatGroupMember(groupId, m));
  }

  try {
    const members = await bridge.apis.contacts.fetchGroupMemberList(groupId);
    return members.map(m => formatGroupMember(groupId, m));
  } catch (err) {
    log.warn(
      'group member fetch failed, using classified cache: uin=%s group=%d err=%s',
      bridge.identity.uin,
      groupId,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    const cached = getCachedGroupMembers(bridge.identity, groupId);
    if (cached.length === 0) throw err;
    return cached;
  }
}

export async function getGroupMemberInfo(
  bridge: BridgeInterface,
  groupId: number,
  userId: number,
  noCache?: boolean,
): Promise<JsonObject | null> {
  const cached = bridge.identity.findGroupMember(groupId, userId);
  if (noCache || !cached || cached.isRobot === undefined) {
    await fetchSingleGroupMembers(bridge, groupId, noCache === true);
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
      last_upload_time: folder.lastUploadTime,
      last_uploader: folder.lastUploader,
      last_uploader_name: folder.lastUploaderName,
    } as JsonObject)),
  };
}

function formatStrangerInfo(p: UserProfileInfo): JsonObject {
  return {
    user_id: p.uin,
    nickname: p.nickname,
    remark: p.remark,
    sex: p.sex,
    age: p.age,
    long_nick: p.sign,
    qq_level: p.level,
    level: p.level,
    status: p.status ?? 0,
    extStatus: p.extStatus ?? 0,
    ext_status: p.extStatus ?? 0,
    batteryStatus: p.batteryStatus ?? 0,
    customStatus: p.customStatus ?? null,
    customStatusDescInfo: p.customStatusDesc ?? '',
    qidian_master_flag: p.qidianMasterFlag ?? 0,
    qidian_crew_flag: p.qidianCrewFlag ?? 0,
    qidian_crew_flag_2: p.qidianCrewFlag2 ?? 0,
  };
}

export async function getStrangerInfo(
  bridge: BridgeInterface,
  userId: number,
): Promise<JsonObject | null> {
  try {
    const p = await bridge.apis.contacts.fetchUserProfile(userId);
    return formatStrangerInfo(p);
  } catch {
    const p = bridge.identity.findUserProfile(userId);
    if (p) {
      return formatStrangerInfo({
        ...p,
        remark: p.remark || bridge.identity.findFriend(userId)?.remark || '',
      });
    }

    const friend = bridge.identity.findFriend(userId);
    if (!friend) return null;
    return {
      user_id: friend.uin,
      nickname: friend.nickname,
      remark: friend.remark,
      sex: 'unknown',
      age: 0,
      long_nick: '',
    };
  }
}

async function resolveRequesterUins(
  bridge: BridgeInterface,
  requests: readonly GroupRequestInfo[],
): Promise<Map<string, { uin: number; name: string }>> {
  const resolved = new Map<string, { uin: number; name: string }>();
  const unresolved = new Set<string>();
  const names = new Map<string, string>();
  const unresolvedUins = new Set<number>();

  for (const request of requests) {
    const actor = groupRequestActor(request);
    const uid = actor.uid;
    if (actor.name) names.set(uid || `uin:${actor.uin}`, actor.name);
    if (uid && actor.uin > 0 && actor.name) {
      resolved.set(uid, { uin: actor.uin, name: actor.name });
      unresolved.delete(uid);
      continue;
    }
    if (uid) {
      if (resolved.has(uid) || unresolved.has(uid)) continue;
      const cached = bridge.identity.findUinByUid(uid, request.groupId)
        ?? bridge.identity.findUinByUid(uid);
      if (cached && cached > 0 && actor.name) {
        resolved.set(uid, { uin: cached, name: actor.name });
      } else {
        unresolved.add(uid);
      }
      continue;
    }
    if (actor.uin > 0 && !actor.name) unresolvedUins.add(actor.uin);
  }

  const profiles = await mapWithConcurrency(
    [...unresolved],
    REQUESTER_PROFILE_CONCURRENCY,
    async (uid) => {
      let profile: UserProfileInfo;
      try {
        profile = await bridge.apis.contacts.fetchUserProfileByUid(uid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to resolve requester UIN for UID ${uid}: ${message}`, { cause: error });
      }
      if (!Number.isSafeInteger(profile.uin) || profile.uin <= 0) {
        throw new Error(`failed to resolve requester UIN for UID ${uid}`);
      }
      return [uid, profile] as const;
    },
  );
  for (const [uid, profile] of profiles) {
    resolved.set(uid, {
      uin: profile.uin,
      name: names.get(uid) || profile.nickname || '',
    });
  }

  const uinProfiles = await mapWithConcurrency(
    [...unresolvedUins],
    REQUESTER_PROFILE_CONCURRENCY,
    async (uin) => {
      try {
        return [uin, await bridge.apis.contacts.fetchUserProfile(uin)] as const;
      } catch {
        return [uin, undefined] as const;
      }
    },
  );
  for (const [uin, profile] of uinProfiles) {
    if (!profile) continue;
    resolved.set(`uin:${uin}`, { uin: profile.uin, name: profile.nickname || '' });
  }
  return resolved;
}

/** Join request (7) or invite that still needs an admin (5 / mapped 22). */
function isJoinOrInviteNotify(notifyType: number | undefined): boolean {
  return notifyType === undefined
    || notifyType === 1
    || notifyType === 5
    || notifyType === 7
    || notifyType === 22;
}

function groupRequestActor(request: GroupRequestInfo): {
  uid: string;
  uin: number;
  name: string;
} {
  if (request.notifyType === 1) {
    return {
      uid: request.invitorUid,
      uin: request.invitorUin,
      name: request.invitorName,
    };
  }
  return {
    uid: request.targetUid,
    uin: request.targetUin,
    name: request.targetName,
  };
}

export async function getGroupSystemMessages(
  bridge: BridgeInterface,
  query: GroupSystemMessageQuery = {},
): Promise<JsonObject[]> {
  const count = query.count ?? 50;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new Error(`invalid group-system-message count: ${count}`);
  }
  const [main, filtered] = await Promise.all([
    bridge.apis.contacts.fetchGroupRequests(false, count),
    bridge.apis.contacts.fetchGroupRequests(true, count),
  ]);
  const unique = new Map<string, GroupRequestInfo>();
  for (const request of [...main, ...filtered]) {
    if (!isJoinOrInviteNotify(request.notifyType)) continue;
    if (request.eventType <= 0) continue;
    const flag = formatGroupRequestFlag(request);
    if (!unique.has(flag)) unique.set(flag, request);
  }
  const requests = [...unique.values()].filter((request) => {
    if (query.groupId !== undefined && request.groupId !== query.groupId) return false;
    if (query.onlyPending && request.state !== 1) return false;
    return true;
  });
  const requesterUins = await resolveRequesterUins(bridge, requests);

  return requests.map((request) => {
    const actor = groupRequestActor(request);
    const resolved = (actor.uid ? requesterUins.get(actor.uid) : undefined)
      ?? (actor.uin > 0 ? requesterUins.get(`uin:${actor.uin}`) : undefined);
    return {
      group_id: request.groupId,
      group_name: request.groupName,
      request_id: request.sequence,
      requester_uin: resolved?.uin ?? actor.uin,
      requester_nick: resolved?.name || actor.name,
      invitor_uin: request.invitorUin,
      invitor_nick: request.invitorName,
      message: request.comment,
      checked: request.state !== 1,
      flag: formatGroupRequestFlag(request),
    };
  });
}

export async function getDownloadRKeys(bridge: BridgeInterface): Promise<JsonObject[]> {
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
  member: GroupMemberInfo,
): JsonObject {
  if (member.isRobot === undefined) {
    throw new Error(
      `group member robot classification unavailable: group=${groupId} member=${member.uin}`,
    );
  }
  return {
    group_id: groupId,
    user_id: member.uin,
    nickname: member.nickname,
    card: member.card,
    is_robot: member.isRobot,
    sex: 'unknown',
    age: 0,
    join_time: member.joinTime,
    last_sent_time: member.lastSentTime,
    shut_up_timestamp: member.shutUpTime,
    level: String(member.level),
    role: member.role,
    title: member.title,
    // OneBot v11 completeness (#197). QQ NT doesn't expose these, so they're
    // fixed placeholders — matching go-cqhttp / NapCat, which also hardcode
    // them: area='', unfriendly=false, title_expire_time=0, card_changeable=true.
    area: '',
    unfriendly: false,
    title_expire_time: 0,
    card_changeable: true,
  };
}
