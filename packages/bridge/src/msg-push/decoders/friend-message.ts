import type { FriendMessage } from '../../events';
import type { MsgPushDecoder } from '../registry';
import { decodeRichBody } from '../rich-body-decoder';

export const decodeFriendMessage: MsgPushDecoder = (ctx) => {
  const ev: FriendMessage = {
    kind: 'friend_message',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    senderUin: ctx.fromUin,
    msgSeq: ctx.head.sequence,
    msgId: ctx.head.msgId & 0x7FFFFFFF,
    elements: decodeRichBody(ctx.body, false),
    senderNick: '',
  };
  if (ctx.responseHead?.forward?.friendName) {
    ev.senderNick = ctx.responseHead.forward.friendName;
  }
  const friend = ctx.identity.findFriend(ctx.fromUin);
  if (friend && !ev.senderNick) ev.senderNick = friend.nickname;
  return [ev];
};
