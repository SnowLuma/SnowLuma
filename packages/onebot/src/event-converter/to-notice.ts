import type { QQEventVariant } from '@snowluma/protocol/events';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT } from '../message-id';
import type { JsonObject } from '../types';
import type { ConverterContext } from './index';
import { applyMessageIdResolver, isSameActor } from './utils';

type GroupMemberJoin = Extract<QQEventVariant, { kind: 'group_member_join' }>;
type GroupMemberLeave = Extract<QQEventVariant, { kind: 'group_member_leave' }>;
type GroupMute = Extract<QQEventVariant, { kind: 'group_mute' }>;
type GroupAdmin = Extract<QQEventVariant, { kind: 'group_admin' }>;
type FriendRecall = Extract<QQEventVariant, { kind: 'friend_recall' }>;
type GroupRecall = Extract<QQEventVariant, { kind: 'group_recall' }>;
type FriendPoke = Extract<QQEventVariant, { kind: 'friend_poke' }>;
type GroupPoke = Extract<QQEventVariant, { kind: 'group_poke' }>;
type GroupEssence = Extract<QQEventVariant, { kind: 'group_essence' }>;
type GroupFileUpload = Extract<QQEventVariant, { kind: 'group_file_upload' }>;
type FriendAdd = Extract<QQEventVariant, { kind: 'friend_add' }>;
type GroupMsgEmojiLike = Extract<QQEventVariant, { kind: 'group_msg_emoji_like' }>;

export function convertGroupMemberJoin(ctx: ConverterContext, event: GroupMemberJoin): JsonObject {
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'notice',
    notice_type: 'group_increase',
    sub_type: isSameActor(event.operatorUin, event.operatorUid, event.userUin, event.userUid) ? 'approve' : 'invite',
    group_id: event.groupId,
    operator_id: event.operatorUin,
    user_id: event.userUin,
  };
}

export function convertGroupMemberLeave(ctx: ConverterContext, event: GroupMemberLeave): JsonObject {
  let subType: string;
  switch (event.leaveType) {
    case 'disband':
      subType = 'disband';
      break;
    case 'kick':
      subType = event.userUin === ctx.selfId ? 'kick_me' : 'kick';
      break;
    default:
      subType = 'leave';
  }
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'notice',
    notice_type: 'group_decrease',
    sub_type: subType,
    group_id: event.groupId,
    operator_id: event.operatorUin,
    user_id: event.userUin,
  };
}

export function convertGroupMute(ctx: ConverterContext, event: GroupMute): JsonObject {
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'notice',
    notice_type: 'group_ban',
    sub_type: event.duration > 0 ? 'ban' : 'lift_ban',
    group_id: event.groupId,
    operator_id: event.operatorUin,
    user_id: event.userUin,
    duration: event.duration,
  };
}

export function convertGroupAdmin(ctx: ConverterContext, event: GroupAdmin): JsonObject {
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'notice',
    notice_type: 'group_admin',
    sub_type: event.set ? 'set' : 'unset',
    group_id: event.groupId,
    user_id: event.userUin,
  };
}

export function convertFriendRecall(ctx: ConverterContext, event: FriendRecall): JsonObject {
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, false, event.userUin, event.msgSeq, PRIVATE_MESSAGE_EVENT,
  );
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'notice',
    notice_type: 'friend_recall',
    user_id: event.userUin,
    message_id: messageId,
  };
}

export function convertGroupRecall(ctx: ConverterContext, event: GroupRecall): JsonObject {
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, true, event.groupId, event.msgSeq, GROUP_MESSAGE_EVENT,
  );
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'notice',
    notice_type: 'group_recall',
    group_id: event.groupId,
    operator_id: event.operatorUin,
    user_id: event.authorUin,
    message_id: messageId,
  };
}

export function convertFriendPoke(ctx: ConverterContext, event: FriendPoke): JsonObject {
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    user_id: event.userUin,
    target_id: event.targetUin,
    action: event.action,
    suffix: event.suffix,
    action_img_url: event.actionImgUrl,
  };
}

export function convertGroupPoke(ctx: ConverterContext, event: GroupPoke): JsonObject {
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: event.groupId,
    user_id: event.userUin,
    target_id: event.targetUin,
    action: event.action,
    suffix: event.suffix,
    action_img_url: event.actionImgUrl,
  };
}

export function convertGroupEssence(ctx: ConverterContext, event: GroupEssence): JsonObject {
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, true, event.groupId, event.msgSeq, GROUP_MESSAGE_EVENT,
  );
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'notice',
    notice_type: 'essence',
    sub_type: event.set ? 'add' : 'delete',
    group_id: event.groupId,
    user_id: event.senderUin,
    sender_id: event.senderUin,
    operator_id: event.operatorUin,
    message_id: messageId,
    message_seq: event.msgSeq,
    random: event.random,
  };
}

export function convertGroupFileUpload(ctx: ConverterContext, event: GroupFileUpload): JsonObject {
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'notice',
    notice_type: 'group_upload',
    group_id: event.groupId,
    user_id: event.userUin,
    file: {
      id: event.fileId,
      name: event.fileName,
      size: event.fileSize,
      busid: event.busId,
    },
  };
}

export function convertFriendAdd(ctx: ConverterContext, event: FriendAdd): JsonObject {
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'notice',
    notice_type: 'friend_add',
    user_id: event.userUin,
  };
}

export function convertGroupMsgEmojiLike(ctx: ConverterContext, event: GroupMsgEmojiLike): JsonObject {
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, true, event.groupId, event.msgSeq, GROUP_MESSAGE_EVENT,
  );
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'notice',
    notice_type: 'group_msg_emoji_like',
    sub_type: event.isAdd ? 'add' : 'remove',
    group_id: event.groupId,
    user_id: event.operatorUin,
    operator_id: event.operatorUin,
    message_id: messageId,
    message_seq: event.msgSeq,
    likes: [{ emoji_id: event.emojiId, count: event.count }],
  };
}
