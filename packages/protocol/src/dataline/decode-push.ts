import type { FriendMessage } from '../events';
import type { MsgPushContext } from '../msg-push/context';
import { decodeDatalineMsgBody, elementsFromDatalineBody } from './codec';
import {
  DATALINE_SELF_TER_TYPE,
  findDatalineDeviceByTerType,
} from './device-contacts';

/**
 * Incoming my-device chats reuse the private-file push type but carry a
 * different body. Rewrite the conversation peer onto the matching device
 * contact — both sides of the wire use the logged-in account number.
 */
export function tryDecodeDatalineFriendMessage(ctx: MsgPushContext): FriendMessage | null {
  if (ctx.head.msgType !== 529 || ctx.head.subType !== 7) return null;
  const raw = ctx.body?.msgContent;
  if (!raw || raw.length === 0) return null;
  const body = decodeDatalineMsgBody(raw);
  if (!body) return null;
  if (
    body.subCmd == null
    && !body.header
    && !body.generic
    && !(body.ftn && body.ftn.length > 0)
  ) {
    return null;
  }

  const elements = elementsFromDatalineBody(body);
  const srcTer = body.header?.srcTerType ?? 0;
  const dstTer = body.header?.dstTerType ?? 0;
  const sentBySelf = srcTer === DATALINE_SELF_TER_TYPE;
  const peerTer = peerTerType(srcTer, dstTer);
  const peer = findDatalineDeviceByTerType(peerTer);
  const sequenceAuthoritative = ctx.head.ntMsgSeq > 0;

  return {
    kind: 'friend_message',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    senderUin: sentBySelf ? ctx.selfUin : (peer?.uin ?? ctx.fromUin),
    senderUid: sentBySelf ? ctx.fromUid : (peer?.uid ?? ctx.fromUid),
    ...(peer ? { peerUin: peer.uin } : {}),
    msgSeq: ctx.head.sequence,
    ntMsgSeq: ctx.head.ntMsgSeq,
    clientSeq: ctx.head.sequence,
    sequenceAuthoritative,
    msgId: ctx.head.msgId & 0x7FFFFFFF,
    elements,
    senderNick: sentBySelf ? '' : (peer?.name ?? ''),
  };
}

function peerTerType(srcTer: number, dstTer: number): number {
  if (srcTer !== DATALINE_SELF_TER_TYPE && srcTer > 0) return srcTer;
  if (dstTer !== DATALINE_SELF_TER_TYPE && dstTer > 0) return dstTer;
  return dstTer || srcTer || DATALINE_SELF_TER_TYPE;
}
