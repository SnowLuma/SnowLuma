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
