import type { Bridge } from '../bridge/bridge';
import type { ForwardNodePayload, MessageElement } from '../bridge/events';
import type { QQInfo } from '../bridge/qq-info';
import type { ApiActionContext, MessageSendResult } from './api-handler';
import type { EventConverter } from './event-converter';
import { elementsToOneBotSegments } from './event-converter';
import { MessageStore } from './message-store';
import { parseMessage } from './message-parser';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT, hashMessageIdInt32 } from './message-id';
import type { MediaStore } from './media-store';
import type { JsonObject, JsonValue, MessageMeta, OneBotConfig } from './types';
import { createLogger } from '../utils/logger';
import {WebHonorType} from "@/bridge/web/group-honor";

const log = createLogger('OneBot');

/**
 * Single shared context bag that flows through every OneBot instance-internal
 * subsystem: API builder and the per-kind event pipeline.
 *
 * Only fields that are actually read through this bag live here — the api
 * handler and network manager are owned by `OneBotInstance` directly because
 * nothing reads them via ctx, and including them here would force a
 * chicken-and-egg `late-bound` field dance during construction.
 *
 * `dispatchEvent` is the indirection used by the event pipeline to hand a
 * converted OneBot event back to the instance for caching + adapter fan-out;
 * it lets the pipeline stay decoupled from the network manager.
 */
export interface OneBotInstanceContext {
  /** Self UIN as string (matches what's on disk and on the wire). */
  uin: string;
  /** Self UIN parsed once, used in event payloads. */
  selfId: number;

  qqInfo: QQInfo;
  bridge: Bridge;

  messageStore: MessageStore;
  mediaStore: MediaStore;

  eventConverter: EventConverter;

  config: OneBotConfig;
  musicSignUrl?: string;

  /** Persist meta about a message id; safe to call any number of times. */
  cacheMessageMeta(messageId: number, meta: MessageMeta): void;
  /** Hand a fully-converted OneBot event to the network manager + caches. */
  dispatchEvent(event: JsonObject): void;
}

export function buildApiContext(ref: OneBotInstanceContext): ApiActionContext {
  const { bridge, qqInfo, messageStore, mediaStore } = ref;

  return {
    getLoginInfo: () => getLoginInfo(ref),
    isOnline: () => true,
    getMessage: (messageId) => messageStore.findEvent(messageId),
    getMessageMeta: (messageId) => messageStore.findMeta(messageId),
    canSendImage: () => true,
    canSendRecord: () => true,
    sendPrivateMessage: (userId, message, autoEscape) => handleSendPrivate(ref, userId, message, autoEscape),
    sendGroupMessage: (groupId, message, autoEscape) => handleSendGroup(ref, groupId, message, autoEscape),
    deleteMessage: (messageId, meta) => handleDeleteMessage(bridge, meta),
    // Info retrieval (async, triggers OIDB fetch)
    getFriendList: () => handleGetFriendList(bridge, qqInfo),
    getGroupList: (noCache) => handleGetGroupList(bridge, qqInfo, noCache),
    getGroupInfo: (groupId, noCache) => handleGetGroupInfo(bridge, qqInfo, groupId, noCache),
    getGroupMemberList: (groupId, noCache) => handleGetGroupMemberList(bridge, qqInfo, groupId, noCache),
    getGroupMemberInfo: (groupId, userId, noCache) => handleGetGroupMemberInfo(bridge, qqInfo, groupId, userId, noCache),
    getStrangerInfo: (userId) => handleGetStrangerInfo(bridge, qqInfo, userId),
    // Group admin
    setGroupKick: (groupId, userId, reject) => bridge.kickGroupMember(groupId, userId, reject),
    setGroupKickMembers: (groupId, userIds, reject) => bridge.kickGroupMembers(groupId, userIds, reject),
    setGroupBan: (groupId, userId, duration) => bridge.muteGroupMember(groupId, userId, duration),
    setGroupWholeBan: (groupId, enable) => bridge.muteGroupAll(groupId, enable),
    setGroupAddOption: (groupId, addType) => bridge.setGroupAddOption(groupId, addType),
    setGroupSearch: (groupId) => bridge.setGroupSearch(groupId),
    setGroupAdmin: (groupId, userId, enable) => bridge.setGroupAdmin(groupId, userId, enable),
    setGroupCard: (groupId, userId, card) => bridge.setGroupCard(groupId, userId, card),
    setGroupName: (groupId, name) => bridge.setGroupName(groupId, name),
    setGroupLeave: (groupId) => bridge.leaveGroup(groupId),
    setGroupSpecialTitle: (groupId, userId, title) => bridge.setGroupSpecialTitle(groupId, userId, title),
    getGroupAtAllRemain: (groupId) => bridge.getGroupAtAllRemain(groupId),
    // Group file
    uploadGroupFile: async (groupId, file, name, folderId, uploadFile) => {
      const result = await bridge.uploadGroupFile(groupId, file, name ?? '', folderId ?? '/', uploadFile ?? true);
      return result.fileId;
    },
    uploadPrivateFile: async (userId, file, name, uploadFile) => {
      const result = await bridge.uploadPrivateFile(userId, file, name ?? '', uploadFile ?? true);
      return result.fileId;
    },
    getGroupFileUrl: (groupId, fileId, busId) => bridge.fetchGroupFileUrl(groupId, fileId, busId ?? 102),
    getGroupFiles: (groupId, folderId) => handleGetGroupFiles(bridge, groupId, folderId),
    deleteGroupFile: (groupId, fileId) => bridge.deleteGroupFile(groupId, fileId),
    moveGroupFile: (groupId, fileId, parentDirectory, targetDirectory) => bridge.moveGroupFile(groupId, fileId, parentDirectory, targetDirectory),
    createGroupFileFolder: (groupId, name, parentId) => bridge.createGroupFileFolder(groupId, name, parentId ?? '/'),
    deleteGroupFileFolder: (groupId, folderId) => bridge.deleteGroupFileFolder(groupId, folderId),
    renameGroupFileFolder: (groupId, folderId, newName) => bridge.renameGroupFileFolder(groupId, folderId, newName),
    getPrivateFileUrl: (userId, fileId, fileHash) => bridge.fetchPrivateFileUrl(userId, fileId, fileHash),
    // Requests
    handleFriendRequest: (flag, approve) => bridge.setFriendAddRequest(flag, approve),
    handleGroupRequest: (flag, _subType, approve, reason) => handleGroupAddRequest(bridge, flag, approve, reason),
    // Extended
    sendLike: (userId, times) => bridge.sendLike(userId, times),
    sendFriendPoke: (userId, targetId) => bridge.sendPoke(false, userId, targetId),
    sendGroupPoke: (groupId, userId) => bridge.sendPoke(true, groupId, userId),
    setEssenceMsg: (messageId) => handleSetEssence(bridge, messageStore, messageId, true),
    deleteEssenceMsg: (messageId) => handleSetEssence(bridge, messageStore, messageId, false),
    getProfileLike: (userId?: number, start: number = 0, limit: number = 10) => bridge.getProfileLike(userId, start, limit),
    fetchCustomFace: (count?: number) => bridge.fetchCustomFace(count),
    getEmojiLikes: (groupId, sequence, emojiId, emojiType, count, cookie) => bridge.getEmojiLikes(groupId, sequence, emojiId, emojiType, count, cookie),
    getUnidirectionalFriendList: () => bridge.getUnidirectionalFriendList(),
    setSelfLongNick: (longNick) => bridge.setSelfLongNick(longNick),
    setInputStatus: (userId, eventType) => bridge.setInputStatus(userId, eventType),
    translateEn2Zh: (words) => bridge.translateEn2Zh(words),
    getMiniAppArk: (type, title, desc, picUrl, jumpUrl) => bridge.getMiniAppArk(type, title, desc, picUrl, jumpUrl),
    clickInlineKeyboardButton: (groupId, botAppid, buttonId, callbackData, msgSeq) => bridge.clickInlineKeyboardButton(groupId, botAppid, buttonId, callbackData, msgSeq),
    sendGroupSign: (groupId) => bridge.sendGroupSign(groupId),
    // New extended
    setGroupReaction: (groupId, sequence, code, isSet) => bridge.setGroupReaction(groupId, sequence, code, isSet),
    handleDeleteFriend: (userId, block) => bridge.deleteFriend(userId, !!block),
    getGroupMsgHistory: (groupId, messageId, count) => handleGetGroupMsgHistory(messageStore, groupId, messageId, count),
    getFriendMsgHistory: (userId, messageId, count) => handleGetFriendMsgHistory(messageStore, userId, messageId, count),
    handleGetGroupSystemMsg: async () => {
      try {
        const reqs = await bridge.fetchGroupRequests();
        return reqs.map(r => ({
          group_id: r.groupId, group_name: r.groupName,
          request_id: r.sequence, requester_uin: r.targetUin,
          requester_nick: r.targetName, message: r.comment,
          flag: `${r.eventType}:${r.groupId}:${r.targetUid}`,
        } as JsonObject));
      } catch { return []; }
    },
    getDownloadRKeys: async () => {
      try {
        const rkeys = await bridge.fetchDownloadRKeys();
        return rkeys.map(r => ({
          rkey: r.rkey, type: r.type, ttl: r.ttlSeconds, create_time: r.createTime,
        } as JsonObject));
      } catch { return []; }
    },
    sendGroupForwardMsg: async (groupId, messages) => {
      return handleSendGroupForward(ref, groupId, messages);
    },
    sendPrivateForwardMsg: async (userId, messages) => {
      return handleSendPrivateForward(ref, userId, messages);
    },
    sendForwardMsg: async (messages) => {
      return handleUploadForward(ref, messages);
    },
    getForwardMsg: async (resId) => {
      return handleGetForward(ref, resId);
    },
    forceFetchClientKey: async () => bridge.forceFetchClientKey(),

    // Extended NapCat-compatible
    setFriendRemark: (userId, remark) => bridge.setFriendRemark(userId, remark),
    setGroupRemark: (groupId, remark) => bridge.setGroupRemark(groupId, remark),
    getGroupFileCount: (groupId) => bridge.fetchGroupFileCount(groupId),
    setMsgEmojiLike: async (messageId, emojiId, set) => {
      const meta = messageStore.findMeta(messageId);
      if (!meta || !meta.isGroup) throw new Error('message not found or not a group message');
      await bridge.setGroupReaction(meta.targetId, meta.sequence, emojiId, set);
    },
    markGroupMsgAsRead: (groupId: number, sequence: number) => bridge.markGroupMsgAsRead(groupId, sequence),
    markPrivateMsgAsRead: (userId: number, sequence: number) => bridge.markPrivateMsgAsRead(userId, sequence),
    setOnlineStatus: (status: number, extStatus?: number, batteryStatus?: number) => bridge.setOnlineStatus(status, extStatus, batteryStatus),
    setProfile: (nickname?: string, personalNote?: string) => bridge.setProfile(nickname, personalNote),
    // web
    getGroupHonorInfo: (groupId: number, type: WebHonorType | string)=> bridge.getGroupHonorInfo(groupId, type),
    getGroupEssence: (groupId: number, pageStart: number = 0, pageLimit: number = 50) => bridge.getGroupEssence(groupId, pageStart, pageLimit),
    getGroupEssenceAll: (groupId: number) => bridge.getGroupEssenceAll(groupId),
    sendGroupNotice: (groupId: number, content: string, options?: any) => bridge.sendGroupNotice(groupId, content, options),
    getGroupNotice: (groupId: number) => bridge.getGroupNotice(groupId),
    deleteGroupNotice: (groupId: number, fid: string) => bridge.deleteGroupNotice(groupId, fid),
    getCookiesStr: (domain: string) => bridge.getCookiesStr(domain),
    getCsrfToken: () => bridge.getCsrfToken(),
    getCredentials: (domain: string) => bridge.getCredentials(domain),
    // Media lookup
    getImageInfo: (file) => handleGetImageInfo(mediaStore, file),
    getRecordInfo: (file) => handleGetRecordInfo(bridge, mediaStore, file),
    // Avatar
    setAvatar: (source: string) => bridge.setAvatar(source),
  };
}

// --- Media lookup ---

async function handleGetImageInfo(
  mediaStore: MediaStore,
  file: string,
): Promise<JsonObject | null> {
  const cached = mediaStore.findImage(file);
  if (!cached) return null;
  const url = cached.url || cached.imageUrl || '';
  return {
    file: url || cached.file,
    url,
    file_size: String(cached.fileSize ?? 0),
    file_name: cached.fileName || cached.file,
  };
}

async function handleGetRecordInfo(
  bridge: Bridge,
  mediaStore: MediaStore,
  file: string,
): Promise<JsonObject | null> {
  const cached = mediaStore.findRecord(file);
  if (!cached) return null;

  // Re-resolve via OIDB if the cached URL is missing or empty.
  // Mirrors NapCat's getPttUrl path: GetGroupPttUrl / GetPttUrl by fileUuid.
  let url = cached.url;
  if (!url && cached.mediaNode) {
    try {
      url = cached.isGroup
        ? await bridge.fetchGroupPttUrlByNode(cached.sessionId, cached.mediaNode)
        : await bridge.fetchPrivatePttUrlByNode(cached.mediaNode);
      if (url) {
        mediaStore.updateRecordUrl(file, url);
      }
    } catch (err) {
      log.warn('get_record url refetch failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  return {
    file: url || cached.file,
    url: url || '',
    file_size: String(cached.fileSize ?? 0),
    file_name: cached.fileName || cached.file,
  };
}

// --- Login info ---

function getLoginInfo(ref: OneBotInstanceContext): { userId: number; nickname: string } {
  const userId = parseInt(ref.uin, 10) || 0;
  const nickname = ref.qqInfo.nickname || ref.uin;
  return { userId, nickname };
}

// NOTE: do NOT iterate all groups here. Calling fetchGroupMemberList for
// every group on demand causes a fan-out (1 incoming request -> N OIDB
// 0xfe7_3 calls where N = group count). When a busy OneBot client (e.g.
// MaiBot) issues `get_group_member_info(no_cache=true)` per inbound
// message, this amplifier produced ~hundreds of OIDB calls per chat
// message and triggered Tencent risk-control / 7-day account ban.
// Each handler below now refreshes only the resource it actually needs.

async function refreshGroupListOnly(bridge: Bridge, qqInfo: QQInfo): Promise<void> {
  try {
    await bridge.fetchGroupList();
  } catch { /* use cached */ }
  void qqInfo;
}

async function refreshSingleGroupMembers(bridge: Bridge, groupId: number): Promise<void> {
  try {
    await bridge.fetchGroupMemberList(groupId);
  } catch { /* use cached */ }
}

function normalizeHistoryCount(count?: number): number {
  if (!Number.isFinite(count)) return 20;
  const n = Math.trunc(count as number);
  if (n <= 0) return 20;
  if (n > 200) return 200;
  return n;
}

function sanitizeMessageEventForApi(event: JsonObject): JsonObject {
  const result: JsonObject = { ...event };
  delete result.post_type;
  delete result.self_id;
  result.real_id = (result.message_id ?? 0) as JsonValue;
  return result;
}

// --- Info retrieval ---

async function handleGetFriendList(bridge: Bridge, qqInfo: QQInfo): Promise<JsonObject[]> {
  try {
    const friends = await bridge.fetchFriendList();
    return friends.map(f => ({
      user_id: f.uin as any,
      nickname: f.nickname as any,
      remark: f.remark as any,
    }));
  } catch {
    return qqInfo.friends.map(f => ({
      user_id: f.uin as any,
      nickname: f.nickname as any,
      remark: f.remark as any,
    }));
  }
}

async function handleGetGroupList(bridge: Bridge, qqInfo: QQInfo, noCache?: boolean): Promise<JsonObject[]> {
  try {
    if (noCache || qqInfo.groups.length === 0) {
      await bridge.fetchGroupList();
    }
  } catch { /* use cached */ }
  return qqInfo.groups.map(g => ({
    group_id: g.groupId as any,
    group_name: g.groupName as any,
    member_count: g.memberCount as any,
    max_member_count: g.memberMax as any,
  }));
}

async function handleGetGroupInfo(bridge: Bridge, qqInfo: QQInfo, groupId: number, noCache?: boolean): Promise<JsonObject | null> {
  if (noCache || !qqInfo.findGroup(groupId)) {
    try { await bridge.fetchGroupList(); } catch { /* use cached */ }
  }
  const g = qqInfo.findGroup(groupId);
  if (!g) return null;
  return {
    group_id: g.groupId as any,
    group_name: g.groupName as any,
    member_count: g.memberCount as any,
    max_member_count: g.memberMax as any,
  };
}

async function handleGetGroupMemberList(bridge: Bridge, qqInfo: QQInfo, groupId: number, noCache?: boolean): Promise<JsonObject[]> {
  if (noCache) {
    await refreshSingleGroupMembers(bridge, groupId);

    const g = qqInfo.findGroup(groupId);
    if (!g) return [];
    const result: JsonObject[] = [];
    for (const [, m] of g.members) {
      result.push({
        group_id: groupId as any, user_id: m.uin as any,
        nickname: m.nickname as any, card: m.card as any,
        sex: 'unknown' as any, age: 0 as any,
        join_time: m.joinTime as any, last_sent_time: m.lastSentTime as any,
        level: String(m.level) as any, role: m.role as any, title: m.title as any,
      });
    }
    return result;
  }

  try {
    const members = await bridge.fetchGroupMemberList(groupId);
    return members.map(m => ({
      group_id: groupId as any,
      user_id: m.uin as any,
      nickname: m.nickname as any,
      card: m.card as any,
      sex: 'unknown' as any,
      age: 0 as any,
      join_time: m.joinTime as any,
      last_sent_time: m.lastSentTime as any,
      level: String(m.level) as any,
      role: m.role as any,
      title: m.title as any,
    }));
  } catch {
    const g = qqInfo.findGroup(groupId);
    if (!g) return [];
    const result: JsonObject[] = [];
    for (const [, m] of g.members) {
      result.push({
        group_id: groupId as any, user_id: m.uin as any,
        nickname: m.nickname as any, card: m.card as any,
        sex: 'unknown' as any, age: 0 as any,
        join_time: m.joinTime as any, last_sent_time: m.lastSentTime as any,
        level: String(m.level) as any, role: m.role as any, title: m.title as any,
      });
    }
    return result;
  }
}

async function handleGetGroupMemberInfo(bridge: Bridge, qqInfo: QQInfo, groupId: number, userId: number, noCache?: boolean): Promise<JsonObject | null> {
  if (noCache || !qqInfo.findGroupMember(groupId, userId)) {
    await refreshSingleGroupMembers(bridge, groupId);
  }
  const m = qqInfo.findGroupMember(groupId, userId);
  if (!m) return null;
  return {
    group_id: groupId as any, user_id: m.uin as any,
    nickname: m.nickname as any, card: m.card as any,
    sex: 'unknown' as any, age: 0 as any,
    join_time: m.joinTime as any, last_sent_time: m.lastSentTime as any,
    level: String(m.level) as any, role: m.role as any, title: m.title as any,
  };
}

async function handleGetGroupFiles(bridge: Bridge, groupId: number, folderId?: string): Promise<JsonObject> {
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

async function handleGetStrangerInfo(bridge: Bridge, qqInfo: QQInfo, userId: number): Promise<JsonObject | null> {
  try {
    const p = await bridge.fetchUserProfile(userId);
    return {
      user_id: p.uin as any,
      nickname: p.nickname as any,
      sex: p.sex as any,
      age: p.age as any,
    };
  } catch {
    const p = qqInfo.findUserProfile(userId);
    if (!p) return null;
    return { user_id: p.uin as any, nickname: p.nickname as any, sex: p.sex as any, age: p.age as any };
  }
}

// --- Message history ---

async function handleGetGroupMsgHistory(
  messageStore: MessageStore,
  groupId: number,
  messageId?: number,
  count?: number,
): Promise<JsonObject[]> {
  if (!Number.isInteger(groupId) || groupId <= 0) return [];
  const limit = normalizeHistoryCount(count);

  let anchorSequence: number | undefined;
  if (Number.isInteger(messageId) && messageId !== 0) {
    const meta = messageStore.findMeta(messageId as number);
    if (!meta || !meta.isGroup || meta.targetId !== groupId || meta.sequence <= 0) return [];
    anchorSequence = meta.sequence;
  }

  const events = messageStore.listSessionEvents(true, groupId, limit, anchorSequence);
  return events
    .filter((event) => {
      if (event.message_type !== 'group') return false;
      const gid = Number(event.group_id ?? 0);
      return Number.isFinite(gid) && Math.trunc(gid) === groupId;
    })
    .map(sanitizeMessageEventForApi);
}

async function handleGetFriendMsgHistory(
  messageStore: MessageStore,
  userId: number,
  messageId?: number,
  count?: number,
): Promise<JsonObject[]> {
  if (!Number.isInteger(userId) || userId <= 0) return [];
  const limit = normalizeHistoryCount(count);

  let anchorSequence: number | undefined;
  if (Number.isInteger(messageId) && messageId !== 0) {
    const meta = messageStore.findMeta(messageId as number);
    if (!meta || meta.isGroup || meta.targetId !== userId || meta.sequence <= 0) return [];
    anchorSequence = meta.sequence;
  }

  const events = messageStore.listSessionEvents(false, userId, limit, anchorSequence);
  return events
    .filter((event) => {
      if (event.message_type !== 'private') return false;
      const uid = Number(event.user_id ?? 0);
      return Number.isFinite(uid) && Math.trunc(uid) === userId;
    })
    .map(sanitizeMessageEventForApi);
}

// --- Delete message ---

async function handleDeleteMessage(bridge: Bridge, meta: MessageMeta): Promise<void> {
  if (meta.isGroup) {
    await bridge.recallGroupMessage(meta.targetId, meta.sequence);
  } else {
    await bridge.recallPrivateMessage(
      meta.targetId, meta.clientSequence, meta.sequence, meta.random, meta.timestamp);
  }
}

// --- Group request ---

async function handleGroupAddRequest(bridge: Bridge, flag: string, approve: boolean, reason: string): Promise<void> {
  // flag format: "add:groupId:uid" or "invite:groupId:uid" (from event-converter)
  const parts = flag.split(':');
  if (parts.length < 3) throw new Error('invalid group request flag');
  const groupId = parseInt(parts[1], 10);
  if (!groupId) throw new Error('invalid group_id in flag');
  // We need sequence and eventType -- fetch from group requests
  const requests = await bridge.fetchGroupRequests();
  const matching = requests.find(r => r.groupId === groupId);
  if (matching) {
    await bridge.setGroupAddRequest(groupId, matching.sequence, matching.eventType, approve, reason, matching.filtered);
  } else {
    throw new Error('matching group request not found');
  }
}

// --- Essence ---

async function handleSetEssence(bridge: Bridge, messageStore: MessageStore, messageId: number, enable: boolean): Promise<void> {
  const meta = messageStore.findMeta(messageId);
  if (!meta || !meta.isGroup) throw new Error('message not found or not a group message');
  await bridge.setGroupEssence(meta.targetId, meta.sequence, meta.random, enable);
}

// --- Send message logging ---

function logSentMessage(isGroup: boolean, targetId: number, elements: MessageElement[]): void {
  const type = isGroup ? '群聊' : '私聊';
  const parts: string[] = [];
  
  // Check for reply element
  const replyElem = elements.find(e => e.type === 'reply');
  if (replyElem && replyElem.replyMessageId) {
    parts.push(`[回复:${replyElem.replyMessageId}]`);
  }
  
  // Build message content preview
  for (const elem of elements) {
    if (elem.type === 'reply') continue; // Already handled
    
    switch (elem.type) {
      case 'text':
        if (elem.text) {
          const preview = elem.text.length > 50 ? elem.text.substring(0, 50) + '...' : elem.text;
          parts.push(preview);
        }
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'face':
        parts.push('[表情]');
        break;
      case 'at':
        if (elem.text) parts.push(elem.text.trim());
        break;
      case 'record':
        parts.push('[语音]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'json':
        parts.push('[JSON消息]');
        break;
      case 'xml':
        parts.push('[XML消息]');
        break;
      case 'markdown':
        parts.push('[Markdown]');
        break;
      case 'forward':
        parts.push('[转发消息]');
        break;
      case 'poke':
        parts.push('[戳一戳]');
        break;
      default:
        break;
    }
  }
  
  const content = parts.join(' ').trim() || '[空消息]';
  log.info(`${type} ${targetId} | 发送：${content}`);
}

// --- Send message ---

async function handleSendPrivate(
  ref: OneBotInstanceContext,
  userId: number,
  message: JsonValue,
  autoEscape: boolean,
): Promise<MessageSendResult> {
  const elements = await parseMessage(message, autoEscape, {
    resolveReplySequence: (replyMessageId) => {
      return ref.messageStore.resolveReplySequence(false, userId, replyMessageId);
    },
    resolveReplyMeta: (replyMessageId) => {
      const meta = ref.messageStore.findMeta(replyMessageId);
      if (meta) {
        return {
          senderUin: meta.targetId,  // For received messages, targetId is the sender
          time: meta.timestamp,
          random: meta.random,
        };
      }
      return null;
    },
    resolveMentionUid: (targetUin) => ref.bridge.resolveUserUid(targetUin),
    musicSignUrl: ref.musicSignUrl,
  });
  if (elements.length === 0) throw new Error('message is empty');

  const receipt = await ref.bridge.sendPrivateMessage(userId, elements);
  const messageId = hashMessageIdInt32(receipt.sequence, userId, PRIVATE_MESSAGE_EVENT);

  // Log sent message
  logSentMessage(false, userId, elements);

  // Cache the sent message meta
  ref.cacheMessageMeta(messageId, {
    isGroup: false,
    targetId: userId,
    sequence: receipt.sequence,
    eventName: PRIVATE_MESSAGE_EVENT,
    clientSequence: receipt.clientSequence,
    random: receipt.random,
    timestamp: receipt.timestamp,
  });

  return { messageId };
}

async function handleSendGroup(
  ref: OneBotInstanceContext,
  groupId: number,
  message: JsonValue,
  autoEscape: boolean,
): Promise<MessageSendResult> {
  const elements = await parseMessage(message, autoEscape, {
    resolveReplySequence: (replyMessageId) => {
      return ref.messageStore.resolveReplySequence(true, groupId, replyMessageId);
    },
    resolveReplyMeta: (replyMessageId) => {
      const event = ref.messageStore.findEvent(replyMessageId);
      if (event) {
        return {
          senderUin: typeof event.user_id === 'number' ? event.user_id : parseInt(String(event.user_id || '0'), 10),
          time: typeof event.time === 'number' ? event.time : parseInt(String(event.time || '0'), 10),
          random: 0,  // Group messages might not have random field in event
        };
      }
      return null;
    },
    resolveMentionUid: (targetUin) => ref.bridge.resolveUserUid(targetUin, groupId),
    musicSignUrl: ref.musicSignUrl,
  });
  if (elements.length === 0) throw new Error('message is empty');

  const receipt = await ref.bridge.sendGroupMessage(groupId, elements);
  const messageId = hashMessageIdInt32(receipt.sequence, groupId, GROUP_MESSAGE_EVENT);

  // Log sent message
  logSentMessage(true, groupId, elements);

  // Cache the sent message meta
  ref.cacheMessageMeta(messageId, {
    isGroup: true,
    targetId: groupId,
    sequence: receipt.sequence,
    eventName: GROUP_MESSAGE_EVENT,
    clientSequence: receipt.clientSequence,
    random: receipt.random,
    timestamp: receipt.timestamp,
  });

  return { messageId };
}

async function handleSendGroupForward(
  ref: OneBotInstanceContext,
  groupId: number,
  messages: JsonValue,
): Promise<{ messageId: number; forwardId: string }> {
  const nodes = await parseForwardNodes(ref, messages);
  const forwardId = await ref.bridge.uploadForwardNodes(nodes, groupId);
  const receipt = await ref.bridge.sendGroupMessage(groupId, [{ type: 'forward', resId: forwardId }]);
  const messageId = hashMessageIdInt32(receipt.sequence, groupId, GROUP_MESSAGE_EVENT);

  ref.cacheMessageMeta(messageId, {
    isGroup: true,
    targetId: groupId,
    sequence: receipt.sequence,
    eventName: GROUP_MESSAGE_EVENT,
    clientSequence: receipt.clientSequence,
    random: receipt.random,
    timestamp: receipt.timestamp,
  });

  return { messageId, forwardId };
}

async function handleSendPrivateForward(
  ref: OneBotInstanceContext,
  userId: number,
  messages: JsonValue,
): Promise<{ messageId: number; forwardId: string }> {
  const nodes = await parseForwardNodes(ref, messages);
  const forwardId = await ref.bridge.uploadForwardNodes(nodes);
  const receipt = await ref.bridge.sendPrivateMessage(userId, [{ type: 'forward', resId: forwardId }]);
  const messageId = hashMessageIdInt32(receipt.sequence, userId, PRIVATE_MESSAGE_EVENT);

  ref.cacheMessageMeta(messageId, {
    isGroup: false,
    targetId: userId,
    sequence: receipt.sequence,
    eventName: PRIVATE_MESSAGE_EVENT,
    clientSequence: receipt.clientSequence,
    random: receipt.random,
    timestamp: receipt.timestamp,
  });

  return { messageId, forwardId };
}

async function handleUploadForward(
  ref: OneBotInstanceContext,
  messages: JsonValue,
): Promise<{ forwardId: string }> {
  const nodes = await parseForwardNodes(ref, messages);
  const forwardId = await ref.bridge.uploadForwardNodes(nodes);
  return { forwardId };
}

async function handleGetForward(
  ref: OneBotInstanceContext,
  resId: string,
): Promise<JsonObject[]> {
  const nodes = await ref.bridge.fetchForwardNodes(resId);
  const results: JsonObject[] = [];
  for (const node of nodes) {
    results.push({
      type: 'node' as any,
      data: {
        user_id: node.userUin as any,
        nickname: node.nickname as any,
        uin: String(node.userUin) as any,
        name: node.nickname as any,
        content: await elementsToOneBotSegments(node.elements, false, node.userUin) as any,
      } as any,
    } as JsonObject);
  }
  return results;
}

async function parseForwardNodes(ref: OneBotInstanceContext, messages: JsonValue): Promise<ForwardNodePayload[]> {
  if (!Array.isArray(messages)) {
    throw new Error('forward messages must be an array');
  }

  const nodes: ForwardNodePayload[] = [];
  for (const item of messages) {
    const segment = asJsonObject(item);
    if (!segment) continue;

    let nodeData: JsonObject | null = null;
    if (String(segment.type ?? '') === 'node') {
      nodeData = asJsonObject(segment.data);
    } else if (segment.content !== undefined || segment.message !== undefined) {
      nodeData = segment;
    }
    if (!nodeData) continue;

    const messageId = toPositiveInt(nodeData.id ?? nodeData.message_id);
    if (messageId > 0) {
      const event = ref.messageStore.findEvent(messageId);
      if (!event) throw new Error(`forward node message_id not found: ${messageId}`);

      const eventSender = asJsonObject(event.sender) ?? {};
      const nickname = String(eventSender.card ?? eventSender.nickname ?? nodeData.nickname ?? nodeData.name ?? '');
      const userUin = toPositiveInt(event.user_id);
      const content = (event.message ?? event.raw_message ?? '') as JsonValue;
      const elements = await parseMessage(content, false);
      if (userUin > 0 && elements.length > 0) {
        nodes.push({ userUin, nickname: nickname || String(userUin), elements });
      }
      continue;
    }

    const userUin = toPositiveInt(nodeData.user_id ?? nodeData.uin);
    if (userUin <= 0) throw new Error('forward node user_id/uin is required');

    const nickname = String(nodeData.nickname ?? nodeData.name ?? userUin);
    const content = (nodeData.content ?? nodeData.message ?? '') as JsonValue;
    const elements = await parseMessage(content, false);
    if (elements.length === 0) throw new Error(`forward node content is empty: ${userUin}`);

    nodes.push({ userUin, nickname, elements });
  }

  if (nodes.length === 0) {
    throw new Error('forward node list is empty');
  }
  return nodes;
}

function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

function toPositiveInt(value: JsonValue | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
  }
  return 0;
}
