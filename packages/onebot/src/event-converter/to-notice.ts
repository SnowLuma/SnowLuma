import type { QQEventVariant } from '@snowluma/protocol/events';
import { GROUP_MESSAGE_EVENT, privateMessageEventName } from '../message-id';
import type { JsonObject } from '../types';
import type { ConverterContext } from './index';
import { applyMessageIdResolver, isSameActor } from './utils';
import { notice } from './envelope';

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
type FriendInputStatus = Extract<QQEventVariant, { kind: 'friend_input_status' }>;
type GroupNameChange = Extract<QQEventVariant, { kind: 'group_name_change' }>;
type GroupCardChange = Extract<QQEventVariant, { kind: 'group_card_change' }>;
type GroupTitleChange = Extract<QQEventVariant, { kind: 'group_title_change' }>;
type FriendProfileLike = Extract<QQEventVariant, { kind: 'friend_profile_like' }>;
type BotOffline = Extract<QQEventVariant, { kind: 'bot_offline' }>;

export function convertGroupMemberJoin(ctx: ConverterContext, event: GroupMemberJoin): JsonObject {
  return notice(ctx, event, {
    notice_type: 'group_increase',
    sub_type: event.joinType
      ?? (isSameActor(event.operatorUin, event.operatorUid, event.userUin, event.userUid)
        ? 'approve'
        : 'invite'),
    group_id: event.groupId,
    operator_id: event.operatorUin,
    user_id: event.userUin,
  });
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
  return notice(ctx, event, {
    notice_type: 'group_decrease',
    sub_type: subType,
    group_id: event.groupId,
    operator_id: event.operatorUin,
    user_id: event.userUin,
  });
}

export function convertGroupMute(ctx: ConverterContext, event: GroupMute): JsonObject {
  return notice(ctx, event, {
    notice_type: 'group_ban',
    sub_type: event.duration > 0 ? 'ban' : 'lift_ban',
    group_id: event.groupId,
    operator_id: event.operatorUin,
    user_id: event.userUin,
    duration: event.duration,
  });
}

export function convertGroupAdmin(ctx: ConverterContext, event: GroupAdmin): JsonObject {
  return notice(ctx, event, {
    notice_type: 'group_admin',
    sub_type: event.set ? 'set' : 'unset',
    group_id: event.groupId,
    user_id: event.userUin,
  });
}

export function convertFriendRecall(ctx: ConverterContext, event: FriendRecall): JsonObject {
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver,
    false,
    event.userUin,
    event.msgSeq,
    privateMessageEventName(event.recalledBySelf === true, false),
    event.time,
  );
  return notice(ctx, event, {
    notice_type: 'friend_recall',
    user_id: event.userUin,
    message_id: messageId,
  });
}

export function convertGroupRecall(ctx: ConverterContext, event: GroupRecall): JsonObject {
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, true, event.groupId, event.msgSeq, GROUP_MESSAGE_EVENT,
  );
  return notice(ctx, event, {
    notice_type: 'group_recall',
    group_id: event.groupId,
    operator_id: event.operatorUin,
    user_id: event.authorUin,
    message_id: messageId,
  });
}

export function convertFriendPoke(ctx: ConverterContext, event: FriendPoke): JsonObject {
  return notice(ctx, event, {
    notice_type: 'notify',
    sub_type: 'poke',
    user_id: event.userUin,
    target_id: event.targetUin,
    action: event.action,
    suffix: event.suffix,
    action_img_url: event.actionImgUrl,
  });
}

export function convertGroupPoke(ctx: ConverterContext, event: GroupPoke): JsonObject {
  return notice(ctx, event, {
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: event.groupId,
    user_id: event.userUin,
    target_id: event.targetUin,
    action: event.action,
    suffix: event.suffix,
    action_img_url: event.actionImgUrl,
  });
}

export function convertGroupEssence(ctx: ConverterContext, event: GroupEssence): JsonObject {
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, true, event.groupId, event.msgSeq, GROUP_MESSAGE_EVENT,
  );
  return notice(ctx, event, {
    notice_type: 'essence',
    sub_type: event.set ? 'add' : 'delete',
    group_id: event.groupId,
    user_id: event.senderUin,
    sender_id: event.senderUin,
    operator_id: event.operatorUin,
    message_id: messageId,
    message_seq: event.msgSeq,
    random: event.random,
  });
}

export function convertGroupFileUpload(ctx: ConverterContext, event: GroupFileUpload): JsonObject {
  return notice(ctx, event, {
    notice_type: 'group_upload',
    group_id: event.groupId,
    user_id: event.userUin,
    file: {
      id: event.fileId,
      name: event.fileName,
      size: event.fileSize,
      busid: event.busId,
    },
  });
}

export function convertFriendAdd(ctx: ConverterContext, event: FriendAdd): JsonObject {
  return notice(ctx, event, {
    notice_type: 'friend_add',
    user_id: event.userUin,
  });
}

export function convertGroupCardChange(ctx: ConverterContext, event: GroupCardChange): JsonObject {
  // Mirrors NapCat's OB11GroupCardEvent: notice_type group_card with the new and
  // old group cards.
  return notice(ctx, event, {
    notice_type: 'group_card',
    group_id: event.groupId,
    user_id: event.userUin,
    card_new: event.cardNew,
    card_old: event.cardOld,
  });
}

export function convertBotOffline(ctx: ConverterContext, event: BotOffline): JsonObject {
  // Mirrors NapCat's OB11BotOfflineEvent: notice_type bot_offline with the bot's
  // own uin plus the tag/message describing why it went offline.
  return notice(ctx, event, {
    notice_type: 'bot_offline',
    user_id: event.selfUin,
    tag: event.tag,
    message: event.message,
  });
}

export function convertFriendProfileLike(ctx: ConverterContext, event: FriendProfileLike): JsonObject {
  // Mirrors NapCat's OB11ProfileLikeEvent: notify/profile_like with the liker's
  // uin, nickname and like count.
  return notice(ctx, event, {
    notice_type: 'notify',
    sub_type: 'profile_like',
    operator_id: event.operatorUin,
    operator_nick: event.operatorNick,
    times: event.times,
  });
}

export function convertGroupTitleChange(ctx: ConverterContext, event: GroupTitleChange): JsonObject {
  // Mirrors NapCat's OB11GroupTitleEvent: notify/title with the recipient's uin
  // and the granted title text.
  return notice(ctx, event, {
    notice_type: 'notify',
    sub_type: 'title',
    group_id: event.groupId,
    user_id: event.userUin,
    title: event.title,
  });
}

export function convertGroupNameChange(ctx: ConverterContext, event: GroupNameChange): JsonObject {
  // Mirrors NapCat's OB11GroupNameEvent: notify/group_name with the operator's
  // uin as user_id and the new name in `name_new`.
  return notice(ctx, event, {
    notice_type: 'notify',
    sub_type: 'group_name',
    group_id: event.groupId,
    user_id: event.operatorUin,
    name_new: event.name,
  });
}

export function convertFriendInputStatus(ctx: ConverterContext, event: FriendInputStatus): JsonObject {
  // Mirrors NapCat's OB11InputStatusEvent: notify/input_status with the peer's
  // uin, the raw event_type (1 = typing, 3 = recording voice) and status_text.
  return notice(ctx, event, {
    notice_type: 'notify',
    sub_type: 'input_status',
    user_id: event.userUin,
    event_type: event.eventType,
    status_text: event.statusText,
  });
}

export function convertGroupMsgEmojiLike(ctx: ConverterContext, event: GroupMsgEmojiLike): JsonObject {
  const messageId = applyMessageIdResolver(
    ctx.messageIdResolver, true, event.groupId, event.msgSeq, GROUP_MESSAGE_EVENT,
  );
  return notice(ctx, event, {
    notice_type: 'group_msg_emoji_like',
    sub_type: event.isAdd ? 'add' : 'remove',
    group_id: event.groupId,
    user_id: event.operatorUin,
    operator_id: event.operatorUin,
    message_id: messageId,
    message_seq: event.msgSeq,
    likes: [{ emoji_id: event.emojiId, count: event.count }],
  });
}
