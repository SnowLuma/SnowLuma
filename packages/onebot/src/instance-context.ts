import type { WebHonorType } from '@snowluma/protocol/web/group-honor';
import type { Bridge } from '@snowluma/core/bridge';
import type { ApiActionContext } from './api-handler';
import type { ConverterContext } from './event-converter';
import type { MediaStore } from './media-store';
import type { MessageStore } from './message-store';
import type { ReactionStore } from './reaction-store';
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
import type { BridgeInterface } from '@snowluma/core/bridge-interface';

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
  /** Local cache of emoji-reaction events keyed by (group, msgSeq, emoji,
   *  reactor). Fed from `GroupMsgEmojiLikeEvent` push by the event
   *  pipeline; queried by fetch_emoji_like / get_emoji_likes. */
  reactionStore: ReactionStore;

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
  const { bridge, messageStore, mediaStore, reactionStore } = ref;

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

    // Group admin — actions now call `ctx.bridge.apis.groupAdmin.X(...)`
    // directly; no per-method passthrough here anymore.

    // Group file — `getGroupFiles` stays because the module helper
    // enriches uploader/creator names from the identity cache; the
    // rest of the area is called directly via `ctx.bridge.apis.groupFile.*`.
    getGroupFiles: (groupId, folderId) => getGroupFiles(bridge, groupId, folderId),

    // Group request handling stays here because `handleGroupAddRequest`
    // is a module helper (flag parsing + group-request lookup). Friend
    // request handling moved to direct `ctx.bridge.apis.friend.handleRequest`.
    handleGroupRequest: (flag, _subType, approve, reason) => handleGroupAddRequest(bridge, flag, approve, reason),

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

    // Essence — bakes the set/unset boolean (the only "compose with
    // messageStore meta lookup" entry remaining outside of dedicated
    // module helpers).
    setEssenceMsg: (messageId) => setEssenceMessage(bridge, messageStore, messageId, true),
    deleteEssenceMsg: (messageId) => setEssenceMessage(bridge, messageStore, messageId, false),

    // Emoji-like — same shape: meta lookup → bridge call. Group-only
    // (QQ doesn't expose emoji reactions on private chats).
    setMsgEmojiLike: async (messageId, emojiId, set) => {
      const meta = messageStore.findMeta(messageId);
      if (!meta) throw new Error('message not found');
      if (!meta.isGroup) throw new Error('emoji reactions are not supported on private messages');
      await bridge.apis.interaction.setReaction(meta.targetId, meta.sequence, emojiId, set);
    },

    // Fetch reactor user list from local cache, cross-checked against
    // the server's 0x9084_1 summary so callers can tell when the cache
    // is incomplete (push events missed before bot boot, etc).
    fetchEmojiLikeUsers: async (messageId, emojiId, count, offset = 0) => {
      const meta = messageStore.findMeta(messageId);
      if (!meta) throw new Error('message not found');
      if (!meta.isGroup) throw new Error('emoji reactions are not supported on private messages');
      const raw = reactionStore.listUsers(meta.targetId, meta.sequence, emojiId, count, offset);
      const users = raw.map(r => ({ uin: r.operatorUin, uid: r.operatorUid, setAt: r.setAt }));
      const cachedCount = reactionStore.countUsers(meta.targetId, meta.sequence, emojiId);
      // Best-effort server-side count cross-check. If the summary call
      // itself fails (network blip / server hiccup) we fall back to the
      // cached count and report complete=true since we have no contrary
      // evidence.
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
