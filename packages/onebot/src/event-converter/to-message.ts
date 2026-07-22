import type { MessageElement, QQEventVariant } from '@snowluma/protocol/events';
import { segmentsToRawMessage } from '../helper/cq';
import {
  GROUP_MESSAGE_EVENT,
  PRIVATE_MESSAGE_EVENT,
  privateMessageEventName,
} from '../message-id';
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
    ctx.selfId,
  );
}

/**
 * friend_message and temp_message differ only in `sub_type` ('friend' vs
 * 'group'). Friend messages use their conversation peer as the session key,
 * which differs from senderUin on a self-sent echo.
 */
async function convertPrivateMessage(
  ctx: ConverterContext,
  event: FriendMessage | TempMessage,
  subType: 'friend' | 'group',
): Promise<JsonObject> {
  const isSelf = event.senderUin === ctx.selfId;
  const postType = isSelf ? 'message_sent' : 'message';
  const sessionId = event.kind === 'friend_message' && event.peerUin && event.peerUin > 0
    ? event.peerUin
    : event.senderUin;
  // ContentHead field 5 (`msgSeq`) is sender-local in C2C and can collide in
  // both directions. Friend history/pushes expose field 11 (`ntMsgSeq`), which
  // is conversation-wide and therefore the canonical OneBot id input.
  const ntSequence = event.kind === 'friend_message' ? (event.ntMsgSeq ?? 0) : 0;
  const hasCanonicalNtSequence = ntSequence > 0
    && event.sequenceAuthoritative !== false;
  const messageIdSequence = hasCanonicalNtSequence ? ntSequence : event.msgSeq;
  const eventName = event.kind === 'friend_message'
    ? privateMessageEventName(isSelf, hasCanonicalNtSequence)
    : PRIVATE_MESSAGE_EVENT;
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, false, sessionId, messageIdSequence, eventName,
  );
  const segments = await toSegments(ctx, event.elements, false, sessionId);
  const sender: JsonObject = {
    user_id: event.senderUin,
    nickname: event.senderNick,
    sex: 'unknown',
    age: 0,
  };
  // A temp (group-originated) message carries its source group so a client can
  // reply via send_private_msg(user_id, group_id=sender.group_id). Mirrors
  // go-cqhttp / NapCat, which expose it on sender.group_id.
  if (subType === 'group' && 'groupId' in event && event.groupId > 0) {
    sender.group_id = event.groupId;
  }
  const fields: JsonObject = {
    message_type: 'private',
    sub_type: subType,
    message_id: messageId,
    message_seq: event.msgSeq,
    user_id: event.senderUin,
    message: segments,
    raw_message: segmentsToRawMessage(segments),
    font: 0,
    sender,
  };
  if (isSelf && sessionId > 0 && sessionId !== ctx.selfId) fields.target_id = sessionId;
  return message(ctx, event, postType, fields);
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
    group_name: event.groupName,
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
