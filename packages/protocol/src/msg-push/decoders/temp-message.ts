import type { TempMessage } from '../../events';
import type { MsgPushDecoder } from '../registry';
import { decodeRichBody } from '../rich-body-decoder';

export const decodeTempMessage: MsgPushDecoder = (ctx) => {
  const ev: TempMessage = {
    kind: 'temp_message',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    senderUin: ctx.fromUin,
    msgSeq: ctx.head.sequence,
    elements: decodeRichBody(ctx.body, false),
    groupId: 0,
    senderNick: '',
  };
  if (ctx.responseHead?.grp) {
    ev.groupId = ctx.responseHead.grp.groupUin ?? 0;
    ev.senderNick = ctx.responseHead.grp.memberName ?? '';
  }
  if (!ev.senderNick) {
    const friend = ctx.identity.findFriend(ctx.fromUin);
    if (friend) ev.senderNick = friend.nickname;
  }
  return [ev];
};
