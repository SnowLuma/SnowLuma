import type { MessageElement, QQEventVariant } from '@snowluma/bridge/events';
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

// ─────────────── resolver callback types ───────────────

export type ImageUrlResolver = (element: MessageElement, isGroup: boolean) => string;
export type MediaUrlResolver = (element: MessageElement, isGroup: boolean, sessionId: number) => Promise<string>;
export type MessageIdResolver = (isGroup: boolean, sessionId: number, sequence: number, eventName: string) => number;
/**
 * Side-channel callback invoked every time an image / record / video
 * segment is produced, so callers can keep a lookup index (e.g. for
 * `get_image` / `get_record`) without re-scanning the message store.
 */
export type MediaSegmentSink = (
  mediaType: 'image' | 'record' | 'video',
  element: MessageElement,
  data: JsonObject,
  isGroup: boolean,
  sessionId: number,
) => void;

// ─────────────── context ───────────────

/**
 * Everything `convertEvent` needs that isn't on the bridge event itself.
 * Built once per OneBotInstance and passed through unchanged. Resolvers
 * are nullable because tests routinely omit them; when missing, the
 * converter falls back to the bridge event's own fields (e.g. raw
 * `element.url`, raw `event.msgSeq`).
 */
export interface ConverterContext {
  /** Self uin parsed once into a Number for inclusion in `self_id`. */
  selfId: number;
  imageUrlResolver: ImageUrlResolver | null;
  mediaUrlResolver: MediaUrlResolver | null;
  messageIdResolver: MessageIdResolver | null;
  mediaSegmentSink: MediaSegmentSink | null;
}

// ─────────────── dispatcher ───────────────

/**
 * Convert a bridge `QQEventVariant` to the OneBot wire-shape JSON.
 * Returns null for kinds we don't surface (so callers can skip them
 * without an explicit allow-list).
 */
export async function convertEvent(
  ctx: ConverterContext,
  event: QQEventVariant,
): Promise<JsonObject | null> {
  switch (event.kind) {
    // Messages.
    case 'friend_message': return convertFriendMessage(ctx, event);
    case 'group_message': return convertGroupMessage(ctx, event);
    case 'temp_message': return convertTempMessage(ctx, event);

    // Notices.
    case 'group_member_join': return convertGroupMemberJoin(ctx, event);
    case 'group_member_leave': return convertGroupMemberLeave(ctx, event);
    case 'group_mute': return convertGroupMute(ctx, event);
    case 'group_admin': return convertGroupAdmin(ctx, event);
    case 'friend_recall': return convertFriendRecall(ctx, event);
    case 'group_recall': return convertGroupRecall(ctx, event);
    case 'friend_poke': return convertFriendPoke(ctx, event);
    case 'group_poke': return convertGroupPoke(ctx, event);
    case 'group_essence': return convertGroupEssence(ctx, event);
    case 'group_file_upload': return convertGroupFileUpload(ctx, event);
    case 'friend_add': return convertFriendAdd(ctx, event);
    case 'group_msg_emoji_like': return convertGroupMsgEmojiLike(ctx, event);

    // Requests.
    case 'friend_request': return convertFriendRequest(ctx, event);
    case 'group_invite': return convertGroupInvite(ctx, event);

    default:
      return null;
  }
}

// ─────────────── side-channel re-export ───────────────

/**
 * Element-array -> OneBot segment-array helper. Used by
 * `modules/message-actions.ts` for forward-message rebuilding (where
 * we already know the elements but want the OneBot segment shape).
 * The signature stays backwards-compatible: each resolver is an
 * optional positional argument.
 */
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
