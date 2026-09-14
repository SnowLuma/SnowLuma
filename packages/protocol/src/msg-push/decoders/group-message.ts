import type { GroupMessage } from '../../events';
import type { MsgPushDecoder } from '../registry';
import { decodeRichBody } from '../rich-body-decoder';

export const decodeGroupMessage: MsgPushDecoder = (ctx) => {
  const ev: GroupMessage = {
    kind: 'group_message',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    senderUin: ctx.fromUin,
    msgSeq: ctx.head.sequence,
    msgId: ctx.head.msgId & 0x7FFFFFFF,
    elements: decodeRichBody(ctx.body, true),
    groupId: 0,
    groupName: '',
    senderNick: '',
    senderCard: '',
    senderRole: '',
  };
  const grp = ctx.responseHead?.grp;
  if (grp) {
    ev.groupId = grp.groupUin ?? 0;
    // Sender name priority (#201): the group-history fetch fills `memberName`
    // (field 2); the local member cache gives a clean nickname/card split; and
    // live pushes + merged-forward nodes carry the display name in `memberCard`
    // (field 4). Prefer the explicit field-2 name, then the cache, then field 4
    // — the last is what lets a forward node from a group the bot isn't in keep
    // its per-node sender name without a member-list lookup.
    ev.senderNick = grp.memberName ?? '';
  }
  const member = ctx.identity.findGroupMember(ev.groupId, ctx.fromUin);
  if (member) {
    if (!ev.senderNick) ev.senderNick = member.nickname;
    ev.senderCard = member.card;
    ev.senderRole = member.role;
    // [#1] field 4 (memberCard) is the sender's CURRENT display name (group card
    // if set, else base nickname). When it differs from the base nickname it's an
    // up-to-date group card — fresher than the cache, which nothing refreshes on
    // a card change (no push; a quiet group can freeze at warmup for months).
    // Prefer it. (Self-healed back into the cache in packet-pipeline side effects.)
    if (grp?.memberCard && grp.memberCard !== ev.senderNick) {
      ev.senderCard = grp.memberCard;
    }
  } else if (!ev.senderNick && grp?.memberCard) {
    ev.senderNick = grp.memberCard;
  }
  // Group name: prefer the message's own wire field (ResponseGrp field 7 —
  // fresh even right after a rename), fall back to the cached group list, else
  // leave it empty. `ev.groupId` is set above from grp.groupUin.
  ev.groupName = grp?.groupName || ctx.identity.findGroup?.(ev.groupId)?.groupName || '';
  return [ev];
};
