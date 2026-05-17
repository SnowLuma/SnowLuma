// Handles Event0x210 wrapper (528). Internal switch on subType dispatches
// to FriendRequest (35) / FriendRecall (138) / FriendPoke (290).

import { protoDecode } from '../../../protobuf/decode';
import {
  FriendRequestSchema, FriendRecallSchema, GeneralGrayTipInfoSchema,
} from '../../proto/notify';
import type {
  FriendRequestEvent, FriendRecall, FriendPokeEvent, QQEventVariant,
} from '../../events';
import type { MsgPushDecoder } from '../registry';
import type { MsgPushContext } from '../context';
import { Event0x210SubType } from '../enums';
import {
  resolveUidToUin, parseU64OrZero, buildTemplateMap, findTemplateValue,
} from '../helpers';
import { createLogger } from '../../../utils/logger';

const unknownLog = createLogger('MsgPush.Unknown');

export const decodeEvent0x210: MsgPushDecoder = (ctx) => {
  switch (ctx.head.subType as Event0x210SubType) {
    case Event0x210SubType.FriendRequestNotice: return decodeFriendRequest(ctx);
    case Event0x210SubType.FriendRecallNotice: return decodeFriendRecall(ctx);
    case Event0x210SubType.FriendPokeNotice: return decodeFriendPoke(ctx);
  }
  unknownLog.debug('Event0x210 unknown subType=%d', ctx.head.subType);
  return [];
};

function decodeFriendRequest(ctx: MsgPushContext): QQEventVariant[] {
  const request = protoDecode(ctx.content, FriendRequestSchema);
  if (!request?.info) return [];
  const sourceUid = request.info.newSource || request.info.sourceUid || '';
  const ev: FriendRequestEvent = {
    kind: 'friend_request',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    fromUin: resolveUidToUin(ctx.identity, 0, sourceUid, ctx.fromUin),
    fromUid: sourceUid,
    message: request.info.message ?? '',
    flag: sourceUid,
  };
  return [ev];
}

function decodeFriendRecall(ctx: MsgPushContext): QQEventVariant[] {
  const recall = protoDecode(ctx.content, FriendRecallSchema);
  if (!recall?.info) return [];
  const ev: FriendRecall = {
    kind: 'friend_recall',
    time: recall.info.time ?? ctx.head.timestamp,
    selfUin: ctx.selfUin,
    userUin: resolveUidToUin(ctx.identity, 0, recall.info.fromUid ?? '', ctx.fromUin),
    msgSeq: recall.info.clientSequence ?? 0,
  };
  return [ev];
}

function decodeFriendPoke(ctx: MsgPushContext): QQEventVariant[] {
  const grayTip = protoDecode(ctx.content, GeneralGrayTipInfoSchema);
  if (!grayTip || (grayTip.busiType ?? 0n) !== 12n) return [];
  const templates = buildTemplateMap(grayTip.msgTemplParam ?? []);
  const actor = findTemplateValue(templates, 'uin_str1');
  const target = findTemplateValue(templates, 'uin_str2');
  const ev: FriendPokeEvent = {
    kind: 'friend_poke',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    userUin: resolveUidToUin(ctx.identity, 0, actor, parseU64OrZero(actor)),
    targetUin: resolveUidToUin(ctx.identity, 0, target, parseU64OrZero(target)),
    action: findTemplateValue(templates, 'action_str', 'alt_str1'),
    suffix: findTemplateValue(templates, 'suffix_str'),
    actionImgUrl: findTemplateValue(templates, 'action_img_url'),
  };
  return [ev];
}
