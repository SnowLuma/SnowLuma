import type { Bridge } from '@snowluma/core/bridge';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { WebHonorType } from '@snowluma/protocol/web/group-honor';
import type { ApiActionContext } from './api-handler';
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
  dispatchEvent(
    event: JsonObject,
    source?: 'bridge' | 'send',
    startedAt?: number,
  ): void;
}

export function buildApiContext(ref: OneBotInstanceContext): ApiActionContext {
  const { bridge, messageStore, mediaStore, reactionStore } = ref;

  return {
    bridge,

    getLoginInfo: () => getLoginInfo(ref),
    isOnline: () => true,
    getMessage: (messageId) => messageStore.findEvent(messageId),
    getMessageMeta: (messageId) => messageStore.findMeta(messageId),
    cacheMessageMetas: (entries) => messageStore.storeMetas(entries),
    listReadSessions: () => messageStore.listReadSessions(
      bridge.identity.groups.map(group => group.groupId),
    ),
    canSendImage: () => true,
    canSendRecord: () => true,
    sendPrivateMessage: (userId, message, autoEscape, tempGroupId) => sendPrivateMessage(
      ref,
      userId,
      message,
      autoEscape,
      tempGroupId,
      tempGroupId === undefined
        ? (event) => ref.dispatchEvent(event, 'send')
        : undefined,
    ),
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
    sendPrivateForwardMsg: (userId, messages, meta) => sendPrivateForwardMessage(
      ref,
      userId,
      messages,
      meta,
      (event) => ref.dispatchEvent(event, 'send'),
    ),
    sendForwardMsg: (messages, groupId) => uploadForwardMessage(ref, messages, groupId),
    getForwardMsg: (resId) => getForwardMessage(ref, resId),
    forwardSingleMsg: (messageId, target) => forwardSingleMessage(
      ref,
      messageId,
      target,
      target.userId !== undefined
        ? (event) => ref.dispatchEvent(event, 'send')
        : undefined,
    ),
    setEssenceMsg: (messageId) => setEssenceMessage(bridge, messageStore, messageId, true),
    deleteEssenceMsg: (messageId) => setEssenceMessage(bridge, messageStore, messageId, false),
    setMsgEmojiLike: async (messageId, emojiId, set) => {
      const meta = messageStore.findMeta(messageId);
      if (!meta) throw new Error('message not found');
      if (!meta.isGroup) throw new Error('emoji reactions are not supported on private messages');
      if (!hasAuthoritativeSequence(meta)) throw new Error('message has no authoritative QQ sequence');
      await bridge.apis.interaction.setReaction(meta.targetId, meta.sequence, emojiId, set);
      const emojiType = emojiId.length > 3 ? 2 : 1;
      if (set) {
        reactionStore.recordAdd(
          meta.targetId, meta.sequence, emojiId, emojiType,
          ref.selfId, '', Math.floor(Date.now() / 1000),
        );
      } else {
        reactionStore.recordRemove(meta.targetId, meta.sequence, emojiId, ref.selfId);
      }
    },
    fetchEmojiLikeSummary: async (messageId) => {
      const meta = messageStore.findMeta(messageId);
      if (!meta) throw new Error('message not found');
      if (!meta.isGroup) throw new Error('emoji reactions are not supported on private messages');
      if (!hasAuthoritativeSequence(meta)) throw new Error('message has no authoritative QQ sequence');
      const summary = reactionStore.summarizeMessage(meta.targetId, meta.sequence);
      const out: Array<{
        emoji_id: string;
        emoji_type: number;
        count: number;
        last_reaction_time: number;
        users: Array<{ user_id: number }>;
      }> = [];
      for (const entry of summary) {
        let users = reactionStore.listUsers(meta.targetId, meta.sequence, entry.emojiId, 1000, 0)
          .map((user) => ({ user_id: user.operatorUin }));
        try {
          const remote = await bridge.apis.interaction.getEmojiLikes(
            meta.targetId, meta.sequence, entry.emojiId, entry.emojiType, 1000,
          );
          if (remote.users.length > 0) {
            users = remote.users.map((user) => ({ user_id: user.uin }));
          }
        } catch {
          /* keep cached users */
        }
        out.push({
          emoji_id: entry.emojiId,
          emoji_type: entry.emojiType,
          count: Math.max(entry.count, users.length),
          last_reaction_time: entry.lastSetAt,
          users,
        });
      }
      return out;
    },
    fetchEmojiLikeUsers: async (messageId, emojiId, count, offset = 0) => {
      const meta = messageStore.findMeta(messageId);
      if (!meta) throw new Error('message not found');
      if (!meta.isGroup) throw new Error('emoji reactions are not supported on private messages');
      if (!hasAuthoritativeSequence(meta)) throw new Error('message has no authoritative QQ sequence');
      const raw = reactionStore.listUsers(meta.targetId, meta.sequence, emojiId, count, offset);
      let users = raw.map(r => ({ uin: r.operatorUin, uid: r.operatorUid, setAt: r.setAt }));
      const cachedCount = reactionStore.countUsers(meta.targetId, meta.sequence, emojiId);
      let serverCount = cachedCount;
      try {
        const remote = await bridge.apis.interaction.getEmojiLikes(
          meta.targetId, meta.sequence, emojiId, emojiId.length > 3 ? 2 : 1, count,
        );
        if (remote.users.length > 0) {
          serverCount = remote.users.length;
          if (offset === 0) {
            users = remote.users.slice(0, count).map((user) => ({
              uin: user.uin, uid: '', setAt: 0,
            }));
          }
        }
      } catch {
        /* keep cached users / count */
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
