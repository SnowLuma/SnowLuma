import type { TempMessage } from '../../events';
import type { MsgPushDecoder } from '../registry';
import { decodeRichBody } from '../rich-body-decoder';

export const decodeTempMessage: MsgPushDecoder = (ctx) => {
  const sequenceAuthoritative = ctx.head.ntMsgSeq > 0;
  const ev: TempMessage = {
    kind: 'temp_message',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    senderUin: ctx.fromUin,
    msgSeq: ctx.head.sequence,
    ntMsgSeq: ctx.head.ntMsgSeq,
    clientSeq: ctx.head.sequence,
    sequenceAuthoritative,
    elements: decodeRichBody(ctx.body, false),
    groupId: 0,
    senderNick: '',
  };
  if (ctx.responseHead?.grp) {
    ev.groupId = ctx.responseHead.grp.groupUin ?? 0;
    ev.senderNick = ctx.responseHead.grp.memberName ?? '';
  }
  // A group temp session carries its source group in responseHead.forward.
  if (ctx.responseHead?.forward?.tempGroupUin) {
    ev.groupId = ctx.responseHead.forward.tempGroupUin;
  }
  if (!ev.senderNick) {
    const friend = ctx.identity.findFriend(ctx.fromUin);
    if (friend) ev.senderNick = friend.nickname;
  }
  return [ev];
};
