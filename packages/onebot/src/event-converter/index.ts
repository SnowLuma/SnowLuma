import type { MessageElement, QQEventVariant } from '@snowluma/protocol/events';
import type { JsonObject } from '../types';
import {
  convertFriendMessage,
  convertGroupMessage,
  convertTempMessage,
} from './to-message';
import {
  convertFriendAdd,
  convertFriendPoke,
  convertFriendRecall,
  convertGroupAdmin,
  convertGroupEssence,
  convertGroupFileUpload,
  convertGroupMemberJoin,
  convertGroupMemberLeave,
  convertGroupMsgEmojiLike,
  convertGroupMute,
  convertGroupPoke,
  convertGroupRecall,
} from './to-notice';
import {
  convertFriendRequest,
  convertGroupInvite,
} from './to-request';
import { elementsToJson } from './to-segment';

export type ImageUrlResolver = (element: MessageElement, isGroup: boolean) => string | Promise<string>;
export type MediaUrlResolver = (element: MessageElement, isGroup: boolean, sessionId: number) => Promise<string>;
export type MessageIdResolver = (isGroup: boolean, sessionId: number, sequence: number, eventName: string) => number;

export type MediaSegmentSink = (
  mediaType: 'image' | 'record' | 'video',
  element: MessageElement,
  data: JsonObject,
  isGroup: boolean,
  sessionId: number,
) => void;

// ─────────────── context ───────────────

export interface ConverterContext {
  selfId: number;
  imageUrlResolver: ImageUrlResolver | null;
  mediaUrlResolver: MediaUrlResolver | null;
  messageIdResolver: MessageIdResolver | null;
  mediaSegmentSink: MediaSegmentSink | null;
}

// ─────────────── dispatcher ───────────────

/** Converter for one event kind — receives the narrowed event for that kind. */
type ConverterFor<K extends QQEventVariant['kind']> =
  (ctx: ConverterContext, event: Extract<QQEventVariant, { kind: K }>) => JsonObject | Promise<JsonObject>;

/**
 * Every event kind → its converter (or `null` for kinds intentionally not
 * surfaced to OneBot clients). The mapped type is TOTAL over the union, so a
 * new `QQEventVariant` kind that forgets a converter is a compile error here —
 * not a silent `null` at runtime.
 */
type ConverterRegistry = { [K in QQEventVariant['kind']]: ConverterFor<K> | null };

const CONVERTERS: ConverterRegistry = {
  // Messages.
  friend_message: convertFriendMessage,
  group_message: convertGroupMessage,
  temp_message: convertTempMessage,
  // Notices.
  group_member_join: convertGroupMemberJoin,
  group_member_leave: convertGroupMemberLeave,
  group_mute: convertGroupMute,
  group_admin: convertGroupAdmin,
  friend_recall: convertFriendRecall,
  group_recall: convertGroupRecall,
  friend_poke: convertFriendPoke,
  group_poke: convertGroupPoke,
  group_essence: convertGroupEssence,
  group_file_upload: convertGroupFileUpload,
  friend_add: convertFriendAdd,
  group_msg_emoji_like: convertGroupMsgEmojiLike,
  // Requests.
  friend_request: convertFriendRequest,
  group_invite: convertGroupInvite,
  // Internal-only: async voice-to-text result, correlated by a pending
  // fetch_ptt_text; never emitted as an OneBot event.
  ptt_trans_result: null,
};

export async function convertEvent(
  ctx: ConverterContext,
  event: QQEventVariant,
): Promise<JsonObject | null> {
  const converter = CONVERTERS[event.kind];
  if (!converter) return null;
  // The registry ties each key to its own event kind, but indexing by a
  // runtime `event.kind` loses that correlation — one localized cast restores it.
  return (converter as (ctx: ConverterContext, event: QQEventVariant) => JsonObject | Promise<JsonObject>)(ctx, event);
}

export async function elementsToOneBotSegments(
  elements: MessageElement[],
  isGroup: boolean,
  sessionId: number,
  imageUrlResolver?: ImageUrlResolver | null,
  mediaUrlResolver?: MediaUrlResolver | null,
  messageIdResolver?: MessageIdResolver | null,
  mediaSegmentSink?: MediaSegmentSink | null,
) {
  return elementsToJson(
    elements, isGroup, sessionId,
    imageUrlResolver, mediaUrlResolver, messageIdResolver, mediaSegmentSink,
  );
}
