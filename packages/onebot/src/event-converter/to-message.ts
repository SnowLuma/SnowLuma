import type { MessageElement, QQEventVariant } from '@snowluma/protocol/events';
import { segmentsToRawMessage } from '../helper/cq';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT } from '../message-id';
import type { JsonObject } from '../types';
import type { ConverterContext } from './index';
import { elementsToJson } from './to-segment';
import { applyMessageIdResolver } from './utils';
import { message } from './envelope';

type FriendMessage = Extract<QQEventVariant, { kind: 'friend_message' }>;
type GroupMessage = Extract<QQEventVariant, { kind: 'group_message' }>;
type TempMessage = Extract<QQEventVariant, { kind: 'temp_message' }>;

/** Fill the media/id resolvers from ctx — collapses the 7-arg elementsToJson splat. */
function toSegments(ctx: ConverterContext, elements: MessageElement[], isGroup: boolean, sessionId: number) {
  return elementsToJson(
    elements, isGroup, sessionId,
    ctx.imageUrlResolver, ctx.mediaUrlResolver, ctx.messageIdResolver, ctx.mediaSegmentSink,
  );
}

/**
 * friend_message and temp_message differ only in `sub_type` ('friend' vs
 * 'group') — both are private, keyed by senderUin, same sender shape.
 */
async function convertPrivateMessage(
  ctx: ConverterContext,
  event: FriendMessage | TempMessage,
  subType: 'friend' | 'group',
): Promise<JsonObject> {
  const isSelf = event.senderUin === ctx.selfId;
  const postType = isSelf ? 'message_sent' : 'message';
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, false, event.senderUin, event.msgSeq, PRIVATE_MESSAGE_EVENT,
  );
  const segments = await toSegments(ctx, event.elements, false, event.senderUin);
  return message(ctx, event, postType, {
    message_type: 'private',
    sub_type: subType,
    message_id: messageId,
    message_seq: event.msgSeq,
    user_id: event.senderUin,
    message: segments,
    raw_message: segmentsToRawMessage(segments),
    font: 0,
    sender: {
      user_id: event.senderUin,
      nickname: event.senderNick,
      sex: 'unknown',
      age: 0,
    },
  });
}

export function convertFriendMessage(ctx: ConverterContext, event: FriendMessage): Promise<JsonObject> {
  return convertPrivateMessage(ctx, event, 'friend');
}

export function convertTempMessage(ctx: ConverterContext, event: TempMessage): Promise<JsonObject> {
  return convertPrivateMessage(ctx, event, 'group');
}

export async function convertGroupMessage(ctx: ConverterContext, event: GroupMessage): Promise<JsonObject> {
  const isSelf = event.senderUin === ctx.selfId;
  const postType = isSelf ? 'message_sent' : 'message';
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, true, event.groupId, event.msgSeq, GROUP_MESSAGE_EVENT,
  );
  const segments = await toSegments(ctx, event.elements, true, event.groupId);
  return message(ctx, event, postType, {
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    message_seq: event.msgSeq,
    group_id: event.groupId,
    user_id: event.senderUin,
    message: segments,
    raw_message: segmentsToRawMessage(segments),
    font: 0,
    sender: {
      user_id: event.senderUin,
      nickname: event.senderNick,
      card: event.senderCard,
      role: event.senderRole || 'member',
      sex: 'unknown',
      age: 0,
    },
    anonymous: null,
  });
}
