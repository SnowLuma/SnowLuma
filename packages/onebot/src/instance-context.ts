import type { Bridge } from '@snowluma/core/bridge';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { WebHonorType } from '@snowluma/protocol/web/group-honor';
import type { ApiActionContext, MessageSendResult } from './api-handler';
import type { ConverterContext } from './event-converter';
import type { MediaStore } from './media-store';
import type { MessageStore } from './message-store';
import type { TempSessionStore } from './temp-session-store';
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
  fetchPttText as fetchPttTextAction,
  getImageInfo as getCachedImageInfo,
  getRecordInfo as getCachedRecordInfo,
} from './modules/media-actions';
import {
  deleteMessage,
  forwardSingleMessage,
  getForwardMessage,
  getFriendHistory,
  getGroupHistory,
  sendGroupForwardMessage,
  sendGroupMessage,
  sendPrivateForwardMessage,
  sendPrivateMessage,
  setEssenceMessage,
  uploadForwardMessage,
} from './modules/message-actions';
import { handleGroupAddRequest } from './modules/request-actions';
import type { ReactionStore } from './reaction-store';
import { hasAuthoritativeSequence, type JsonObject, type MessageMeta, type OneBotConfig } from './types';

export interface OneBotInstanceContext {
  uin: string;
  selfId: number;
  bridge: BridgeInterface;
  messageStore: MessageStore;
  mediaStore: MediaStore;
  reactionStore: ReactionStore;
  /** Group temp-session records — see {@link TempSessionStore}. */
  tempSessions: TempSessionStore;
  converterCtx: ConverterContext;
  config: OneBotConfig;
  musicSignUrl?: string;
  cacheMessageMeta(messageId: number, meta: MessageMeta): void;
  dispatchEvent(event: JsonObject, source?: 'bridge' | 'send'): void;
}

export function buildApiContext(ref: OneBotInstanceContext): ApiActionContext {
  const { bridge, messageStore, mediaStore, reactionStore } = ref;

  const reportSelfSent = async (result: Promise<MessageSendResult>) => {
    const settled = await result;
    if (settled.echoEvent) ref.dispatchEvent(settled.echoEvent, 'send');
    return settled;
  };

  return {
    bridge,

    getLoginInfo: () => getLoginInfo(ref),
    isOnline: () => true,
    getMessage: (messageId) => messageStore.findEvent(messageId),
    getMessageMeta: (messageId) => messageStore.findMeta(messageId),
    listReadSessions: () => messageStore.listReadSessions(
      bridge.identity.groups.map(group => group.groupId),
    ),
    canSendImage: () => true,
    canSendRecord: () => true,
    sendPrivateMessage: (userId, message, autoEscape, tempGroupId) =>
      tempGroupId === undefined
        ? reportSelfSent(sendPrivateMessage(ref, userId, message, autoEscape))
        : sendPrivateMessage(ref, userId, message, autoEscape, tempGroupId),
    sendGroupMessage: (groupId, message, autoEscape) => sendGroupMessage(ref, groupId, message, autoEscape),
    deleteMessage: (_messageId, meta) => deleteMessage(bridge, meta),
    getFriendList: () => getFriendList(bridge),
    getGroupList: (noCache) => getGroupList(bridge, noCache),
    getGroupInfo: (groupId, noCache) => getGroupInfo(bridge, groupId, noCache),
    getGroupMemberList: (groupId, noCache) => getGroupMemberList(bridge, groupId, noCache),
    getGroupMemberInfo: (groupId, userId, noCache) => getGroupMemberInfo(bridge, groupId, userId, noCache),
    getStrangerInfo: (userId) => getStrangerInfo(bridge, userId),
    getGroupFiles: (groupId, folderId) => getGroupFiles(bridge, groupId, folderId),
    handleGroupRequest: (flag, _subType, approve, reason) => handleGroupAddRequest(bridge, flag, approve, reason),
    getGroupMsgHistory: (groupId, messageId, count, reverseOrder) =>
      getGroupHistory(ref, groupId, messageId, count, reverseOrder),
    getFriendMsgHistory: (userId, messageId, count, reverseOrder) =>
      getFriendHistory(ref, userId, messageId, count, reverseOrder),
    handleGetGroupSystemMsg: (query) => getGroupSystemMessages(bridge, query),
    getDownloadRKeys: () => getDownloadRKeys(bridge),
    sendGroupForwardMsg: (groupId, messages, meta) => sendGroupForwardMessage(ref, groupId, messages, meta),
    sendPrivateForwardMsg: (userId, messages, meta) => sendPrivateForwardMessage(ref, userId, messages, meta),
    sendForwardMsg: (messages, groupId) => uploadForwardMessage(ref, messages, groupId),
    getForwardMsg: (resId) => getForwardMessage(ref, resId),
    forwardSingleMsg: (messageId, target) => forwardSingleMessage(ref, messageId, target),
    setEssenceMsg: (messageId) => setEssenceMessage(bridge, messageStore, messageId, true),
    deleteEssenceMsg: (messageId) => setEssenceMessage(bridge, messageStore, messageId, false),
    setMsgEmojiLike: async (messageId, emojiId, set) => {
      const meta = messageStore.findMeta(messageId);
      if (!meta) throw new Error('message not found');
      if (!meta.isGroup) throw new Error('emoji reactions are not supported on private messages');
      if (!hasAuthoritativeSequence(meta)) throw new Error('message has no authoritative QQ sequence');
      await bridge.apis.interaction.setReaction(meta.targetId, meta.sequence, emojiId, set);
    },
    fetchEmojiLikeUsers: async (messageId, emojiId, count, offset = 0) => {
      const meta = messageStore.findMeta(messageId);
      if (!meta) throw new Error('message not found');
      if (!meta.isGroup) throw new Error('emoji reactions are not supported on private messages');
      if (!hasAuthoritativeSequence(meta)) throw new Error('message has no authoritative QQ sequence');
      const raw = reactionStore.listUsers(meta.targetId, meta.sequence, emojiId, count, offset);
      const users = raw.map(r => ({ uin: r.operatorUin, uid: r.operatorUid, setAt: r.setAt }));
      const cachedCount = reactionStore.countUsers(meta.targetId, meta.sequence, emojiId);
      let serverCount = cachedCount;
      try {
        const summary = await bridge.apis.interaction.fetchReactionSummary(meta.targetId, meta.sequence);
        const match = summary.find(s => s.emojiId === emojiId);
        if (match) serverCount = match.count;
      } catch {
        /* keep serverCount = cachedCount */
      }
      return {
        users,
        cachedCount,
        serverCount,
        complete: cachedCount >= serverCount,
      };
    },
    getImageInfo: (file) => getCachedImageInfo(mediaStore, file, ref.converterCtx.imageUrlResolver),
    getRecordInfo: (file) => getCachedRecordInfo(bridge, mediaStore, file),
    fetchPttText: (messageId) => fetchPttTextAction(messageStore, mediaStore, bridge, ref.selfId, messageId),
  };
}

export type { Bridge, WebHonorType };
