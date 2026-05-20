// Handles Event0x210 wrapper (528). Internal switch on subType dispatches
// to FriendRequest (35) / FriendRecall (138, 139) / NewFriend
// (179, 226) / FriendPoke (290).

import { protobuf_decode } from '@snowluma/proton';
// Proto types imported unaliased — proton's import-resolver registers
// `importedTypeSources` keyed on the *imported* name. If we also did
// `import type { FriendRecall } from '../../events'` it would shadow
// the proto-side mapping (last-write-wins), point the resolver at the
// event-side file which has no `pb<>` schema, and the codec would
// never get generated — `protobuf_decode<FriendRecall>(...)` then
// falls through to the runtime fallback and throws (silently caught
// by `MsgPushRegistry.decode`). The event-side colliding names are
// re-derived from `QQEventVariant` below via `Extract` instead.
import type {
  FriendRequest,
  FriendRecall,
  GeneralGrayTipInfo,
  NewFriend,
} from '../../proto/proton/notify';
import type {
  FriendRequestEvent, FriendPokeEvent,
  FriendAddEvent, QQEventVariant,
} from '../../events';

type FriendRecallEvent = Extract<QQEventVariant, { kind: 'friend_recall' }>;
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
    // 138 (other-recalled) and 139 (self-recalled) share the same
    // FriendRecall wire shape; the helper picks the right uid side
    // based on the subType.
    case Event0x210SubType.FriendRecallNotice:
    case Event0x210SubType.FriendRecallSelfNotice:
      return decodeFriendRecall(ctx);
    case Event0x210SubType.FriendPokeNotice: return decodeFriendPoke(ctx);
    // 179 + 226 both carry the NewFriend payload — see enum comment.
    case Event0x210SubType.NewFriendNotice:
    case Event0x210SubType.NewFriendNoticeAlt:
      return decodeNewFriend(ctx);
    case Event0x210SubType.GroupAppStatePush:
      // QQ-client-internal troop shortcut bar / discussion app state
      // push — no OneBot-level event. See enum comment for the
      // decompiled-source breakdown of the sub_cmd dispatch.
      return [];
    case Event0x210SubType.UnmappedClientState380:
      // QQ-NT-era subType with no reference handler: the legacy QQ
      // Android decompile (tsuzcx/qq_apk) only enumerates SubType0x26
      // through SubType0x146 under msgType0x210/, so 380 / 0x17C is
      // an NT-era addition. None of the NT clients (Lagrange.Core,
      // LagrangeGo, lagrange-python, mania) handle it either. See the
      // enum comment for the full investigation; acknowledge silently
      // until someone maps the schema.
      return [];
  }
  unknownLog.debug('Event0x210 unknown subType=%d', ctx.head.subType);
  return [];
};

function decodeFriendRequest(ctx: MsgPushContext): QQEventVariant[] {
  const request = protobuf_decode<FriendRequest>(ctx.content);
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
  const recall = protobuf_decode<FriendRecall>(ctx.content);
  if (!recall?.info) return [];
  // 138 = friend recalled their own message sent to bot (peer = fromUid).
  // 139 = bot recalled own message sent to friend (peer = toUid). Same
  // ambiguity acidify handles in `parseFriendRecall:380`. Without this
  // split, self-recall events surface `userUin` as the bot itself which
  // confuses downstream OneBot consumers that key off `user_id`.
  const isSelfRecall = ctx.head.subType === Event0x210SubType.FriendRecallSelfNotice;
  const peerUid = (isSelfRecall ? recall.info.toUid : recall.info.fromUid) ?? '';
  const ev: FriendRecallEvent = {
    kind: 'friend_recall',
    time: recall.info.time ?? ctx.head.timestamp,
    selfUin: ctx.selfUin,
    userUin: resolveUidToUin(ctx.identity, 0, peerUid, ctx.fromUin),
    msgSeq: recall.info.clientSequence ?? 0,
  };
  return [ev];
}

function decodeNewFriend(ctx: MsgPushContext): QQEventVariant[] {
  const nf = protobuf_decode<NewFriend>(ctx.content);
  if (!nf?.info) return [];
  const newFriendUid = nf.info.uid ?? '';
  const newFriendUin = resolveUidToUin(ctx.identity, 0, newFriendUid, ctx.fromUin);
  if (newFriendUin <= 0) return []; // can't surface a `user_id`-less friend_add to OneBot
  const ev: FriendAddEvent = {
    kind: 'friend_add',
    // proto field is `fixed32 Time` — already uint32 seconds epoch.
    // Fall back to head.timestamp if the field is missing (some
    // captures have it as 0).
    time: nf.info.time && nf.info.time > 0 ? nf.info.time : ctx.head.timestamp,
    selfUin: ctx.selfUin,
    userUin: newFriendUin,
  };
  return [ev];
}

function decodeFriendPoke(ctx: MsgPushContext): QQEventVariant[] {
  const grayTip = protobuf_decode<GeneralGrayTipInfo>(ctx.content);
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
