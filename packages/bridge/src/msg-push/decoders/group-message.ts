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
    senderNick: '',
    senderCard: '',
    senderRole: '',
  };
  if (ctx.responseHead?.grp) {
    ev.groupId = ctx.responseHead.grp.groupUin ?? 0;
    ev.senderNick = ctx.responseHead.grp.memberName ?? '';
  }
  const member = ctx.identity.findGroupMember(ev.groupId, ctx.fromUin);
  if (member) {
    if (!ev.senderNick) ev.senderNick = member.nickname;
    ev.senderCard = member.card;
    ev.senderRole = member.role;
  }
  return [ev];
};
