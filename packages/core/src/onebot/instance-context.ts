import type { WebHonorType } from '@/bridge/web/group-honor';
import type { Bridge } from '../bridge/bridge';
import type { QQInfo } from '../bridge/qq-info';
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

  qqInfo: QQInfo;
  bridge: Bridge;

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

export function buildApiContext(ref: OneBotInstanceContext): ApiActionContext {
  const { bridge, qqInfo, messageStore, mediaStore } = ref;

  return {
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

    // OneBot11 info actions.
    getFriendList: () => getFriendList(bridge, qqInfo),
    getGroupList: (noCache) => getGroupList(bridge, qqInfo, noCache),
    getGroupInfo: (groupId, noCache) => getGroupInfo(bridge, qqInfo, groupId, noCache),
    getGroupMemberList: (groupId, noCache) => getGroupMemberList(bridge, qqInfo, groupId, noCache),
    getGroupMemberInfo: (groupId, userId, noCache) => getGroupMemberInfo(bridge, qqInfo, groupId, userId, noCache),
    getStrangerInfo: (userId) => getStrangerInfo(bridge, qqInfo, userId),

    // Group admin.
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

    // Group file.
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
    deleteGroupFile: (groupId, fileId) => bridge.deleteGroupFile(groupId, fileId),
    moveGroupFile: (groupId, fileId, parentDirectory, targetDirectory) => {
      return bridge.moveGroupFile(groupId, fileId, parentDirectory, targetDirectory);
    },
    createGroupFileFolder: (groupId, name, parentId) => bridge.createGroupFileFolder(groupId, name, parentId ?? '/'),
    deleteGroupFileFolder: (groupId, folderId) => bridge.deleteGroupFileFolder(groupId, folderId),
    renameGroupFileFolder: (groupId, folderId, newName) => bridge.renameGroupFileFolder(groupId, folderId, newName),
    getPrivateFileUrl: (userId, fileId, fileHash) => bridge.fetchPrivateFileUrl(userId, fileId, fileHash),

    // Requests.
    handleFriendRequest: (flag, approve) => bridge.setFriendAddRequest(flag, approve),
    handleGroupRequest: (flag, _subType, approve, reason) => handleGroupAddRequest(bridge, flag, approve, reason),

    // Extended.
    sendLike: (userId, times) => bridge.sendLike(userId, times),
    sendFriendPoke: (userId, targetId) => bridge.sendPoke(false, userId, targetId),
    sendGroupPoke: (groupId, userId) => bridge.sendPoke(true, groupId, userId),
    setEssenceMsg: (messageId) => setEssenceMessage(bridge, messageStore, messageId, true),
    deleteEssenceMsg: (messageId) => setEssenceMessage(bridge, messageStore, messageId, false),
    getProfileLike: (userId = undefined, start = 0, limit = 10) => bridge.getProfileLike(userId, start, limit),
    fetchCustomFace: (count) => bridge.fetchCustomFace(count),
    getEmojiLikes: (groupId, sequence, emojiId, emojiType, count, cookie) => {
      return bridge.getEmojiLikes(groupId, sequence, emojiId, emojiType, count, cookie);
    },
    getUnidirectionalFriendList: () => bridge.getUnidirectionalFriendList(),
    setSelfLongNick: (longNick) => bridge.setSelfLongNick(longNick),
    setInputStatus: (userId, eventType) => bridge.setInputStatus(userId, eventType),
    translateEn2Zh: (words) => bridge.translateEn2Zh(words),
    getMiniAppArk: (type, title, desc, picUrl, jumpUrl) => bridge.getMiniAppArk(type, title, desc, picUrl, jumpUrl),
    clickInlineKeyboardButton: (groupId, botAppid, buttonId, callbackData, msgSeq) => {
      return bridge.clickInlineKeyboardButton(groupId, botAppid, buttonId, callbackData, msgSeq);
    },
    sendGroupSign: (groupId) => bridge.sendGroupSign(groupId),

    // NapCat-compatible extended actions.
    setGroupReaction: (groupId, sequence, code, isSet) => bridge.setGroupReaction(groupId, sequence, code, isSet),
    handleDeleteFriend: (userId, block) => bridge.deleteFriend(userId, !!block),
    getGroupMsgHistory: (groupId, messageId, count) => getGroupMsgHistory(messageStore, groupId, messageId, count),
    getFriendMsgHistory: (userId, messageId, count) => getFriendMsgHistory(messageStore, userId, messageId, count),
    handleGetGroupSystemMsg: () => getGroupSystemMessages(bridge),
    getDownloadRKeys: () => getDownloadRKeys(bridge),
    sendGroupForwardMsg: (groupId, messages, meta) => sendGroupForwardMessage(ref, groupId, messages, meta),
    sendPrivateForwardMsg: (userId, messages, meta) => sendPrivateForwardMessage(ref, userId, messages, meta),
    sendForwardMsg: (messages) => uploadForwardMessage(ref, messages),
    getForwardMsg: (resId) => getForwardMessage(ref, resId),
    forwardSingleMsg: (messageId, target) => forwardSingleMessage(ref, messageId, target),
    forceFetchClientKey: () => bridge.forceFetchClientKey(),
    setFriendRemark: (userId, remark) => bridge.setFriendRemark(userId, remark),
    setGroupRemark: (groupId, remark) => bridge.setGroupRemark(groupId, remark),
    setGroupAvatar: (groupId, source) => bridge.setGroupAvatar(groupId, source),
    getGroupFileCount: (groupId) => bridge.fetchGroupFileCount(groupId),
    setMsgEmojiLike: async (messageId, emojiId, set) => {
      const meta = messageStore.findMeta(messageId);
      if (!meta || !meta.isGroup) throw new Error('message not found or not a group message');
      await bridge.setGroupReaction(meta.targetId, meta.sequence, emojiId, set);
    },
    markGroupMsgAsRead: (groupId, sequence) => bridge.markGroupMsgAsRead(groupId, sequence),
    markPrivateMsgAsRead: (userId, sequence) => bridge.markPrivateMsgAsRead(userId, sequence),
    setOnlineStatus: (status, extStatus, batteryStatus) => bridge.setOnlineStatus(status, extStatus, batteryStatus),
    setProfile: (nickname, personalNote) => bridge.setProfile(nickname, personalNote),

    // Web-backed actions.
    getGroupHonorInfo: (groupId: number, type: WebHonorType | string) => bridge.getGroupHonorInfo(groupId, type),
    getGroupEssence: (groupId, pageStart = 0, pageLimit = 50) => bridge.getGroupEssence(groupId, pageStart, pageLimit),
    getGroupEssenceAll: (groupId) => bridge.getGroupEssenceAll(groupId),
    getGroupAlbumList: (groupId) => bridge.getGroupAlbumList(groupId),
    uploadImageToGroupAlbum: (groupId, albumId, albumName, filePath) => bridge.uploadImageToGroupAlbum(groupId, albumId, albumName, filePath),
    getGroupAlbumMediaList: (groupId, albumId) => bridge.getGroupAlbumMediaList(groupId, albumId),
    sendGroupNotice: (groupId, content, options) => bridge.sendGroupNotice(groupId, content, options),
    getGroupNotice: (groupId) => bridge.getGroupNotice(groupId),
    deleteGroupNotice: (groupId, fid) => bridge.deleteGroupNotice(groupId, fid),
    getCookiesStr: (domain) => bridge.getCookiesStr(domain),
    getCsrfToken: () => bridge.getCsrfToken(),
    getCredentials: (domain) => bridge.getCredentials(domain),

    // Media lookup.
    getImageInfo: (file) => getCachedImageInfo(mediaStore, file),
    getRecordInfo: (file) => getCachedRecordInfo(bridge, mediaStore, file),

    // Avatar.
    setAvatar: (source) => bridge.setAvatar(source),
  };
}
