import type { WebHonorType } from '@/bridge/web/group-honor';
import type { Bridge } from '../bridge/bridge';
import type { ApiActionContext } from './api-handler';
import type { ConverterContext } from './event-converter';
import type { MediaStore } from './media-store';
import type { MessageStore } from './message-store';
import type { JsonObject, MessageMeta, OneBotConfig } from './types';
import {
  getDownloadRKeys,
  getFriendList,
  getGroupFiles,
  getGroupInfo,
  getGroupList,
  getGroupMemberInfo,
  getGroupMemberList,
  getGroupSystemMessages,
  getLoginInfo,
  getStrangerInfo,
} from './modules/contact-actions';
import {
  deleteMessage,
  forwardSingleMessage,
  getForwardMessage,
  getFriendMsgHistory,
  getGroupMsgHistory,
  sendGroupForwardMessage,
  sendGroupMessage,
  sendPrivateForwardMessage,
  sendPrivateMessage,
  setEssenceMessage,
  uploadForwardMessage,
} from './modules/message-actions';
import {
  getImageInfo as getCachedImageInfo,
  getRecordInfo as getCachedRecordInfo,
} from './modules/media-actions';
import { handleGroupAddRequest } from './modules/request-actions';
import type { BridgeInterface } from '../bridge/bridge-interface';

/**
 * Single shared context bag that flows through every OneBot instance-internal
 * subsystem: API builder and the per-kind event pipeline.
 *
 * Only fields that are actually read through this bag live here. The API
 * handler and network manager are owned by `OneBotInstance` directly because
 * nothing reads them via ctx, and including them here would force a
 * chicken-and-egg late-bound field dance during construction.
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

  bridge: BridgeInterface;

  messageStore: MessageStore;
  mediaStore: MediaStore;

  converterCtx: ConverterContext;

  config: OneBotConfig;
  musicSignUrl?: string;

  /** Persist meta about a message id; safe to call any number of times. */
  cacheMessageMeta(messageId: number, meta: MessageMeta): void;
  /** Hand a fully-converted OneBot event to the network manager + caches. */
  dispatchEvent(event: JsonObject): void;
}

/**
 * Build the ApiActionContext that ApiHandler hands to each action file.
 *
 * Two flavours of entries live in here:
 *   - Adapters — rename a Bridge method (setGroupKick → kickGroupMember),
 *     compose with messageStore / mediaStore / ref, bake in a constant
 *     (setEssenceMsg passes true; deleteEssenceMsg passes false), bridge a
 *     bridge call into OneBot vocabulary (sendFriendPoke flattens the
 *     isGroup boolean), or extract a field from the bridge return shape.
 *   - Pass-throughs used to live here too but added zero value; OneBot
 *     actions now call `ctx.bridge.<name>` directly when no translation is
 *     happening (set_group_admin, set_online_status, set_avatar, …).
 */
export function buildApiContext(ref: OneBotInstanceContext): ApiActionContext {
  const { bridge, messageStore, mediaStore } = ref;

  return {
    bridge,

    getLoginInfo: () => getLoginInfo(ref),
    isOnline: () => true,
    getMessage: (messageId) => messageStore.findEvent(messageId),
    getMessageMeta: (messageId) => messageStore.findMeta(messageId),
    canSendImage: () => true,
    canSendRecord: () => true,

    // OneBot11 message actions.
    sendPrivateMessage: (userId, message, autoEscape) => sendPrivateMessage(ref, userId, message, autoEscape),
    sendGroupMessage: (groupId, message, autoEscape) => sendGroupMessage(ref, groupId, message, autoEscape),
    deleteMessage: (_messageId, meta) => deleteMessage(bridge, meta),

    // OneBot11 info actions (wrap modules that also touch identity).
    getFriendList: () => getFriendList(bridge),
    getGroupList: (noCache) => getGroupList(bridge, noCache),
    getGroupInfo: (groupId, noCache) => getGroupInfo(bridge, groupId, noCache),
    getGroupMemberList: (groupId, noCache) => getGroupMemberList(bridge, groupId, noCache),
    getGroupMemberInfo: (groupId, userId, noCache) => getGroupMemberInfo(bridge, groupId, userId, noCache),
    getStrangerInfo: (userId) => getStrangerInfo(bridge, userId),

    // Group admin — names translate to OneBot vocabulary.
    setGroupKick: (groupId, userId, reject) => bridge.kickGroupMember(groupId, userId, reject),
    setGroupKickMembers: (groupId, userIds, reject) => bridge.kickGroupMembers(groupId, userIds, reject),
    setGroupBan: (groupId, userId, duration) => bridge.muteGroupMember(groupId, userId, duration),
    setGroupWholeBan: (groupId, enable) => bridge.muteGroupAll(groupId, enable),
    setGroupLeave: (groupId) => bridge.leaveGroup(groupId),

    // Group file — fileId field extraction + defaults.
    uploadGroupFile: async (groupId, file, name, folderId, uploadFile) => {
      const result = await bridge.uploadGroupFile(groupId, file, name ?? '', folderId ?? '/', uploadFile ?? true);
      return result.fileId;
    },
    uploadPrivateFile: async (userId, file, name, uploadFile) => {
      const result = await bridge.uploadPrivateFile(userId, file, name ?? '', uploadFile ?? true);
      return result.fileId;
    },
    getGroupFileUrl: (groupId, fileId, busId) => bridge.fetchGroupFileUrl(groupId, fileId, busId ?? 102),
    getGroupFiles: (groupId, folderId) => getGroupFiles(bridge, groupId, folderId),
    createGroupFileFolder: (groupId, name, parentId) => bridge.createGroupFileFolder(groupId, name, parentId ?? '/'),
    getPrivateFileUrl: (userId, fileId, fileHash) => bridge.fetchPrivateFileUrl(userId, fileId, fileHash),

    // Requests — name translation.
    handleFriendRequest: (flag, approve) => bridge.setFriendAddRequest(flag, approve),
    handleGroupRequest: (flag, _subType, approve, reason) => handleGroupAddRequest(bridge, flag, approve, reason),

    // Pokes — flatten isGroup into the bridge signature.
    sendFriendPoke: (userId, targetId) => bridge.sendPoke(false, userId, targetId),
    sendGroupPoke: (groupId, userId) => bridge.sendPoke(true, groupId, userId),

    // Essence — bake the set/unset boolean.
    setEssenceMsg: (messageId) => setEssenceMessage(bridge, messageStore, messageId, true),
    deleteEssenceMsg: (messageId) => setEssenceMessage(bridge, messageStore, messageId, false),

    // Profile-like / get_group_essence — OneBot-specific defaults that the
    // action handlers don't supply.
    getProfileLike: (userId = undefined, start = 0, limit = 10) => bridge.getProfileLike(userId, start, limit),
    getGroupEssence: (groupId, pageStart = 0, pageLimit = 50) => bridge.getGroupEssence(groupId, pageStart, pageLimit),

    // Message-store-backed history reads.
    getGroupMsgHistory: (groupId, messageId, count) => getGroupMsgHistory(messageStore, groupId, messageId, count),
    getFriendMsgHistory: (userId, messageId, count) => getFriendMsgHistory(messageStore, userId, messageId, count),

    // Module wrappers / multi-dep compositions.
    handleGetGroupSystemMsg: () => getGroupSystemMessages(bridge),
    getDownloadRKeys: () => getDownloadRKeys(bridge),
    sendGroupForwardMsg: (groupId, messages, meta) => sendGroupForwardMessage(ref, groupId, messages, meta),
    sendPrivateForwardMsg: (userId, messages, meta) => sendPrivateForwardMessage(ref, userId, messages, meta),
    sendForwardMsg: (messages, groupId) => uploadForwardMessage(ref, messages, groupId),
    getForwardMsg: (resId) => getForwardMessage(ref, resId),
    forwardSingleMsg: (messageId, target) => forwardSingleMessage(ref, messageId, target),
    handleDeleteFriend: (userId, block) => bridge.deleteFriend(userId, !!block),
    forceFetchClientKey: () => bridge.forceFetchClientKey(),
    setFriendRemark: (userId, remark) => bridge.setFriendRemark(userId, remark),
    setGroupRemark: (groupId, remark) => bridge.setGroupRemark(groupId, remark),
    setGroupAvatar: (groupId, source) => bridge.setGroupAvatar(groupId, source),
    getGroupFileCount: (groupId) => bridge.fetchGroupFileCount(groupId),

    // Cross-store: looks up the meta then routes through Bridge.
    setMsgEmojiLike: async (messageId, emojiId, set) => {
      const meta = messageStore.findMeta(messageId);
      if (!meta) throw new Error('message not found');
      // QQ itself doesn't expose emoji reactions on private chats, so
      // there is no wire path to forward this to; fail loudly instead
      // of silently no-op'ing.
      if (!meta.isGroup) throw new Error('emoji reactions are not supported on private messages');
      await bridge.setGroupReaction(meta.targetId, meta.sequence, emojiId, set);
    },
    markGroupMsgAsRead: (groupId, sequence) => bridge.markGroupMsgAsRead(groupId, sequence),
    markPrivateMsgAsRead: (userId, sequence) => bridge.markPrivateMsgAsRead(userId, sequence),
    setOnlineStatus: (status: number, extStatus?: number, batteryStatus?: number) => bridge.setOnlineStatus(status, extStatus, batteryStatus),
    setProfile: (nickname?: string, personalNote?: string) => bridge.setProfile(nickname, personalNote),

    // Web-backed actions.
    getGroupHonorInfo: (groupId: number, type: WebHonorType | string) => bridge.getGroupHonorInfo(groupId, type),
    getGroupEssenceAll: (groupId) => bridge.getGroupEssenceAll(groupId),
    getGroupAlbumList: (groupId) => bridge.getGroupAlbumList(groupId),
    uploadImageToGroupAlbum: (groupId, albumId, albumName, filePath) => bridge.uploadImageToGroupAlbum(groupId, albumId, albumName, filePath),
    getGroupAlbumMediaList: (groupId, albumId, attachInfo) => bridge.getGroupAlbumMediaList(groupId, albumId, attachInfo),
    commentGroupAlbumMedia: (groupId, albumId, lloc, content) => bridge.commentGroupAlbumMedia(groupId, albumId, lloc, content),
    deleteGroupAlbumMedia: (groupId, albumId, lloc) => bridge.deleteGroupAlbumMedia(groupId, albumId, lloc),
    likeGroupAlbumMedia: (groupId, albumId, batchId, lloc, isLike) => bridge.likeGroupAlbumMedia(groupId, albumId, batchId, lloc, isLike),
    sendGroupNotice: (groupId, content, options) => bridge.sendGroupNotice(groupId, content, options),
    getGroupNotice: (groupId) => bridge.getGroupNotice(groupId),
    deleteGroupNotice: (groupId, fid) => bridge.deleteGroupNotice(groupId, fid),
    getCookiesStr: (domain) => bridge.getCookiesStr(domain),
    getCsrfToken: () => bridge.getCsrfToken(),
    getCredentials: (domain) => bridge.getCredentials(domain),

    // Extended
    fetchCustomFace: (count) => bridge.fetchCustomFace(count),
    getEmojiLikes: (groupId, sequence, emojiId, emojiType, count, cookie) => bridge.getEmojiLikes(groupId, sequence, emojiId, emojiType, count, cookie),

    // Media lookup.
    getImageInfo: (file) => getCachedImageInfo(mediaStore, file),
    getRecordInfo: (file) => getCachedRecordInfo(bridge, mediaStore, file),
  };
}

// Re-export Bridge type so consumers of OneBotInstanceContext that need it
// (legacy) keep the import surface stable.
export type { Bridge };

// Re-export WebHonorType so legacy spots that imported it via this module
// keep working.
export type { WebHonorType };
