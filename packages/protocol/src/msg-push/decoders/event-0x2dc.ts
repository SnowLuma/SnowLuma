import { protobuf_decode } from '@snowluma/proton';
import { createLogger } from '@snowluma/common/logger';
import type {
  GroupEssenceEvent,
  GroupMsgEmojiLikeEvent,
  GroupMuteEvent,
  GroupNameChangeEvent,
  GroupTitleChangeEvent,
  GroupPokeEvent,
  GroupRecallEvent,
  QQEventVariant,
} from '../../events';
import type {
  GroupMute,
  GroupNameChange,
  GroupSpecialTitleChange,
  GroupReactNotify,
  NotifyMessageBody,
} from '@snowluma/proto-defs/notify';
import type { MsgPushContext } from '../context';
import { Event0x2DCSubType } from '../enums';
import {
  buildTemplateMap, findTemplateValue,
  resolveUidToUin,
  unwrapGroupNotifyPayload,
} from '../helpers';
import type { MsgPushDecoder } from '../registry';

const unknownLog = createLogger('MsgPush.Unknown');

export const decodeEvent0x2DC: MsgPushDecoder = (ctx) => {
  switch (ctx.head.subType as Event0x2DCSubType) {
    case Event0x2DCSubType.GroupMuteNotice: return decodeGroupMute(ctx);
    case Event0x2DCSubType.GroupMsgEmojiLikeNotice: return decodeSubType16(ctx);
    case Event0x2DCSubType.GroupRecallNotice: return decodeGroupRecall(ctx);
    case Event0x2DCSubType.GroupGreyTipNotice: return decodeGroupGreyTip(ctx);
    case Event0x2DCSubType.GroupEssenceNotice: return decodeGroupEssence(ctx);
  }
  unknownLog.debug('Event0x2DC unknown subType=%d', ctx.head.subType);
  return [];
};

function decodeGroupMute(ctx: MsgPushContext): QQEventVariant[] {
  const mute = protobuf_decode<GroupMute>(ctx.content);
  if (!mute?.data?.state) return [];
  const duration = mute.data.state.duration ?? 0;
  const ev: GroupMuteEvent = {
    kind: 'group_mute',
    time: mute.data.timestamp ?? ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: mute.groupUin ?? 0,
    operatorUin: resolveUidToUin(ctx.identity, mute.groupUin ?? 0, mute.operatorUid ?? ''),
    userUin: resolveUidToUin(ctx.identity, mute.groupUin ?? 0, mute.data.state.targetUid ?? ''),
    duration: duration === 0xFFFFFFFF ? 0x7FFFFFFF : duration,
  };
  return [ev];
}

function decodeGroupRecall(ctx: MsgPushContext): QQEventVariant[] {
  const payload = unwrapGroupNotifyPayload(ctx.content);
  if (!payload) return [];
  const notify = protobuf_decode<NotifyMessageBody>(payload);
  if (!notify?.recall?.recallMessages || notify.recall.recallMessages.length === 0) return [];
  const recalled = notify.recall.recallMessages[0];
  const ev: GroupRecallEvent = {
    kind: 'group_recall',
    time: recalled.time ?? ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: notify.groupUin ?? 0,
    operatorUin: resolveUidToUin(ctx.identity, notify.groupUin ?? 0,
      notify.recall.operatorUid || notify.operatorUid || ''),
    authorUin: resolveUidToUin(ctx.identity, notify.groupUin ?? 0, recalled.authorUid ?? ''),
    msgSeq: recalled.sequence ?? 0,
  };
  return [ev];
}

function decodeGroupGreyTip(ctx: MsgPushContext): QQEventVariant[] {
  const payload = unwrapGroupNotifyPayload(ctx.content);
  if (!payload) return [];
  const notify = protobuf_decode<NotifyMessageBody>(payload);
  if (!notify?.generalGrayTip || (notify.generalGrayTip.busiType ?? 0n) !== 12n) return [];
  const templates = buildTemplateMap(notify.generalGrayTip.msgTemplParam ?? []);
  const actor = findTemplateValue(templates, 'uin_str1');
  const target = findTemplateValue(templates, 'uin_str2');
  const ev: GroupPokeEvent = {
    kind: 'group_poke',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: notify.groupUin ?? 0,
    userUin: resolveUidToUin(ctx.identity, notify.groupUin ?? 0, actor),
    targetUin: resolveUidToUin(ctx.identity, notify.groupUin ?? 0, target),
    action: findTemplateValue(templates, 'action_str', 'alt_str1'),
    suffix: findTemplateValue(templates, 'suffix_str'),
    actionImgUrl: findTemplateValue(templates, 'action_img_url'),
  };
  return [ev];
}

function decodeGroupEssence(ctx: MsgPushContext): QQEventVariant[] {
  const payload = unwrapGroupNotifyPayload(ctx.content);
  if (!payload) return [];
  const notify = protobuf_decode<NotifyMessageBody>(payload);
  if (!notify?.essenceMessage) return [];
  const essence = notify.essenceMessage;
  const setFlag = essence.setFlag ?? essence.setFlag2 ?? 0;
  const ev: GroupEssenceEvent = {
    kind: 'group_essence',
    time: essence.timestamp ?? ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: essence.groupUin ?? notify.groupUin ?? 0,
    senderUin: essence.memberUin ?? 0,
    operatorUin: essence.operatorUin ?? 0,
    msgSeq: essence.msgSequence ?? essence.msgSequence2 ?? notify.msgSequence ?? 0,
    random: essence.random ?? 0,
    set: setFlag === 1,
  };
  return [ev];
}

// Magic prefix QQ prepends to the GroupReactNotify payload inside
// body.msgContent for Event0x2DC subType=16. Same value NapCat strips
// (see api/group.ts: `msgContent?.slice(7)`).
const GROUP_REACT_PREFIX_BYTES = 7;
// Discriminator on GroupReactNotify.field13 — same subType is reused
// for other notify variants, only 35 means "emoji react". Anything
// else falls through to MsgPush.Unknown for protocol-drift visibility.
const GROUP_REACT_DISCRIMINATOR = 35;
// Event 0x2DC subType 16 multiplexes several group notices, discriminated by
// `NotifyMessageBody.field13`. RE cross-ref (Lagrange Event0x2DCSubType16Field13,
// itself RE'd from wrapper.linux.node): 6=special title, 12=name change, 23=todo,
// 35=emoji reaction. We peek field13 off the shared NotifyMessageBody, then branch.
const SUBTYPE16_SPECIAL_TITLE = 6;
const SUBTYPE16_GROUP_NAME_CHANGE = 12;

function decodeSubType16(ctx: MsgPushContext): QQEventVariant[] {
  if (ctx.content.length <= GROUP_REACT_PREFIX_BYTES) return [];
  const field13 = protobuf_decode<NotifyMessageBody>(ctx.content.subarray(GROUP_REACT_PREFIX_BYTES))?.field13 ?? 0;
  switch (field13) {
    case SUBTYPE16_SPECIAL_TITLE: return decodeGroupTitle(ctx);
    case SUBTYPE16_GROUP_NAME_CHANGE: return decodeGroupName(ctx);
    case GROUP_REACT_DISCRIMINATOR: return decodeGroupMsgEmojiLike(ctx);
    default:
      unknownLog.debug('Event0x2DC subType=16 unhandled field13=%d', field13);
      return [];
  }
}

// field13 == 6: a member was granted a special title. eventParam carries the
// member uin (f5) + a gray-tip template string (f2); the title text is the last
// `<{"…","text":TITLE,…}>` rich token in that string (on-wire captured shape —
// the kernel resolves the template to a clean string, we parse it here).
function decodeGroupTitle(ctx: MsgPushContext): QQEventVariant[] {
  const notify = protobuf_decode<NotifyMessageBody>(ctx.content.subarray(GROUP_REACT_PREFIX_BYTES));
  const param = notify?.eventParam
    ? protobuf_decode<GroupSpecialTitleChange>(notify.eventParam)
    : undefined;
  const userUin = param?.memberUin ?? 0;
  const title = extractTitleFromTip(param?.tipText ?? '');
  if (!userUin || !title) return [];
  const ev: GroupTitleChangeEvent = {
    kind: 'group_title_change',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: notify?.groupUin ?? 0,
    userUin,
    title,
  };
  return [ev];
}

// The tip text is "恭喜<{member}>获得群主授予的<{…"text":TITLE…}>头衔" — the title is
// the `text` of the LAST `<{…}>` rich token (the one just before "头衔"). Tokens
// are flat JSON with no `<`/`>` inside, so a non-greedy scan is safe.
function extractTitleFromTip(text: string): string {
  const tokens = text.match(/<\{[^<>]*\}>/g);
  if (!tokens || tokens.length === 0) return '';
  const last = tokens[tokens.length - 1];
  try {
    const parsed = JSON.parse(last.slice(1, -1)) as { text?: string };
    return parsed.text ?? '';
  } catch {
    return '';
  }
}

// field13 == 12: group renamed. New name is nested in `eventParam` as a
// `GroupNameChange` (field 2); operator is `NotifyMessageBody.operatorUid`.
function decodeGroupName(ctx: MsgPushContext): QQEventVariant[] {
  const notify = protobuf_decode<NotifyMessageBody>(ctx.content.subarray(GROUP_REACT_PREFIX_BYTES));
  const name = notify?.eventParam ? (protobuf_decode<GroupNameChange>(notify.eventParam)?.name ?? '') : '';
  if (!name) return [];
  const groupId = notify?.groupUin ?? 0;
  const ev: GroupNameChangeEvent = {
    kind: 'group_name_change',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId,
    // Operator is a group member → resolves from the roster. Fall back to 0
    // (not ctx.fromUin, which on a 0x2DC push is the group id) so an
    // unresolved operator never surfaces the group id as user_id.
    operatorUin: resolveUidToUin(ctx.identity, groupId, notify?.operatorUid ?? ''),
    name,
  };
  return [ev];
}

function decodeGroupMsgEmojiLike(ctx: MsgPushContext): QQEventVariant[] {
  if (ctx.content.length <= GROUP_REACT_PREFIX_BYTES) return [];
  const payload = ctx.content.subarray(GROUP_REACT_PREFIX_BYTES);
  const notify = protobuf_decode<GroupReactNotify>(payload);
  if (!notify) return [];
  if ((notify.field13 ?? 0) !== GROUP_REACT_DISCRIMINATOR) {
    unknownLog.debug('Event0x2DC subType=16 unhandled field13=%d (expected %d for emoji react)',
      notify.field13 ?? 0, GROUP_REACT_DISCRIMINATOR);
    return [];
  }
  const content = notify.groupReactionData?.data?.data?.groupReactionDataContent;
  const target = notify.groupReactionData?.data?.data?.groupReactionTarget;
  if (!content) return [];

  const groupId = Number(notify.groupUin ?? 0n);
  const operatorUid = content.operatorUid ?? '';
  const emojiId = content.code ?? '';
  const count = content.count ?? 1;
  // type is QQ's add/remove discriminator: 1 = react added, 2 = react
  // removed. Older payloads occasionally omit it; default to "add"
  // since most clients can only generate add events.
  const isAdd = (content.type ?? 1) === 1;
  const msgSeq = Number(target?.seq ?? 0n);

  const ev: GroupMsgEmojiLikeEvent = {
    kind: 'group_msg_emoji_like',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId,
    operatorUin: resolveUidToUin(ctx.identity, groupId, operatorUid),
    operatorUid,
    msgSeq,
    emojiId,
    count,
    isAdd,
  };
  return [ev];
}
