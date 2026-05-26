import type { QQEventVariant } from '@snowluma/protocol/events';
import { segmentsToRawMessage } from '../helper/cq';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT } from '../message-id';
import type { JsonObject } from '../types';
import type { ConverterContext } from './index';
import { elementsToJson } from './to-segment';
import { applyMessageIdResolver } from './utils';

type FriendMessage = Extract<QQEventVariant, { kind: 'friend_message' }>;
type GroupMessage = Extract<QQEventVariant, { kind: 'group_message' }>;
type TempMessage = Extract<QQEventVariant, { kind: 'temp_message' }>;

export async function convertFriendMessage(ctx: ConverterContext, event: FriendMessage): Promise<JsonObject> {
  const isSelf = event.senderUin === ctx.selfId;
  const postType = isSelf ? 'message_sent' : 'message';
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, false, event.senderUin, event.msgSeq, PRIVATE_MESSAGE_EVENT,
  );
  const segments = await elementsToJson(
    event.elements, false, event.senderUin,
    ctx.imageUrlResolver, ctx.mediaUrlResolver, ctx.messageIdResolver, ctx.mediaSegmentSink,
  );
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: postType,
    message_type: 'private',
    sub_type: 'friend',
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
  };
}

export async function convertGroupMessage(ctx: ConverterContext, event: GroupMessage): Promise<JsonObject> {
  const isSelf = event.senderUin === ctx.selfId;
  const postType = isSelf ? 'message_sent' : 'message';
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, true, event.groupId, event.msgSeq, GROUP_MESSAGE_EVENT,
  );
  const segments = await elementsToJson(
    event.elements, true, event.groupId,
    ctx.imageUrlResolver, ctx.mediaUrlResolver, ctx.messageIdResolver, ctx.mediaSegmentSink,
  );
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: postType,
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
  };
}

export async function convertTempMessage(ctx: ConverterContext, event: TempMessage): Promise<JsonObject> {
  const isSelf = event.senderUin === ctx.selfId;
  const postType = isSelf ? 'message_sent' : 'message';
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, false, event.senderUin, event.msgSeq, PRIVATE_MESSAGE_EVENT,
  );
  const segments = await elementsToJson(
    event.elements, false, event.senderUin,
    ctx.imageUrlResolver, ctx.mediaUrlResolver, ctx.messageIdResolver, ctx.mediaSegmentSink,
  );
  const result: JsonObject = {
    time: event.time,
    self_id: ctx.selfId,
    post_type: postType,
    message_type: 'private',
    sub_type: 'group',
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
  };
  if (event.groupId > 0) {
    result.group_id = event.groupId;
  }
  return result;
}
