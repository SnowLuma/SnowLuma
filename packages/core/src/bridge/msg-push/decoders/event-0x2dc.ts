// Handles Event0x2DC wrapper (732). Internal switch on subType dispatches
// to GroupMute (12) / GroupRecall (17) / GroupGreyTip (20) / GroupEssence (21).

import { protoDecode } from '../../../protobuf/decode';
import {
  GroupMuteSchema, NotifyMessageBodySchema,
} from '../../proto/notify';
import type {
  GroupMuteEvent, GroupRecallEvent, GroupPokeEvent, GroupEssenceEvent,
  QQEventVariant,
} from '../../events';
import type { MsgPushDecoder } from '../registry';
import type { MsgPushContext } from '../context';
import { Event0x2DCSubType } from '../enums';
import {
  resolveUidToUin, parseU64OrZero, buildTemplateMap, findTemplateValue,
  unwrapGroupNotifyPayload,
} from '../helpers';
import { createLogger } from '../../../utils/logger';

const unknownLog = createLogger('MsgPush.Unknown');

export const decodeEvent0x2DC: MsgPushDecoder = (ctx) => {
  switch (ctx.head.subType as Event0x2DCSubType) {
    case Event0x2DCSubType.GroupMuteNotice: return decodeGroupMute(ctx);
    case Event0x2DCSubType.GroupRecallNotice: return decodeGroupRecall(ctx);
    case Event0x2DCSubType.GroupGreyTipNotice: return decodeGroupGreyTip(ctx);
    case Event0x2DCSubType.GroupEssenceNotice: return decodeGroupEssence(ctx);
  }
  unknownLog.debug('Event0x2DC unknown subType=%d', ctx.head.subType);
  return [];
};

function decodeGroupMute(ctx: MsgPushContext): QQEventVariant[] {
  const mute = protoDecode(ctx.content, GroupMuteSchema);
  if (!mute?.data?.state) return [];
  const duration = mute.data.state.duration ?? 0;
  const ev: GroupMuteEvent = {
    kind: 'group_mute',
    time: mute.data.timestamp ?? ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: mute.groupUin ?? 0,
    operatorUin: resolveUidToUin(ctx.identity, mute.groupUin ?? 0, mute.operatorUid ?? '', ctx.fromUin),
    userUin: resolveUidToUin(ctx.identity, mute.groupUin ?? 0, mute.data.state.targetUid ?? '', 0),
    duration: duration === 0xFFFFFFFF ? 0x7FFFFFFF : duration,
  };
  return [ev];
}

function decodeGroupRecall(ctx: MsgPushContext): QQEventVariant[] {
  const payload = unwrapGroupNotifyPayload(ctx.content);
  if (!payload) return [];
  const notify = protoDecode(payload, NotifyMessageBodySchema);
  if (!notify?.recall?.recallMessages || notify.recall.recallMessages.length === 0) return [];
  const recalled = notify.recall.recallMessages[0];
  const ev: GroupRecallEvent = {
    kind: 'group_recall',
    time: recalled.time ?? ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: notify.groupUin ?? 0,
    operatorUin: resolveUidToUin(ctx.identity, notify.groupUin ?? 0,
      notify.recall.operatorUid || notify.operatorUid || '', ctx.fromUin),
    authorUin: resolveUidToUin(ctx.identity, notify.groupUin ?? 0, recalled.authorUid ?? '', ctx.fromUin),
    msgSeq: recalled.sequence ?? 0,
  };
  return [ev];
}

function decodeGroupGreyTip(ctx: MsgPushContext): QQEventVariant[] {
  const payload = unwrapGroupNotifyPayload(ctx.content);
  if (!payload) return [];
  const notify = protoDecode(payload, NotifyMessageBodySchema);
  if (!notify?.generalGrayTip || (notify.generalGrayTip.busiType ?? 0n) !== 12n) return [];
  const templates = buildTemplateMap(notify.generalGrayTip.msgTemplParam ?? []);
  const actor = findTemplateValue(templates, 'uin_str1');
  const target = findTemplateValue(templates, 'uin_str2');
  const ev: GroupPokeEvent = {
    kind: 'group_poke',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: notify.groupUin ?? 0,
    userUin: resolveUidToUin(ctx.identity, notify.groupUin ?? 0, actor, parseU64OrZero(actor)),
    targetUin: resolveUidToUin(ctx.identity, notify.groupUin ?? 0, target, parseU64OrZero(target)),
    action: findTemplateValue(templates, 'action_str', 'alt_str1'),
    suffix: findTemplateValue(templates, 'suffix_str'),
    actionImgUrl: findTemplateValue(templates, 'action_img_url'),
  };
  return [ev];
}

function decodeGroupEssence(ctx: MsgPushContext): QQEventVariant[] {
  const payload = unwrapGroupNotifyPayload(ctx.content);
  if (!payload) return [];
  const notify = protoDecode(payload, NotifyMessageBodySchema);
  if (!notify?.essenceMessage) return [];
  const essence = notify.essenceMessage;
  const setFlag = essence.setFlag ?? essence.setFlag2 ?? 0;
  const ev: GroupEssenceEvent = {
    kind: 'group_essence',
    time: essence.timestamp ?? ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: essence.groupUin ?? notify.groupUin ?? 0,
    senderUin: essence.memberUin ?? 0,
    operatorUin: essence.operatorUin ?? ctx.fromUin,
    msgSeq: essence.msgSequence ?? essence.msgSequence2 ?? notify.msgSequence ?? 0,
    random: essence.random ?? 0,
    set: setFlag === 1,
  };
  return [ev];
}
