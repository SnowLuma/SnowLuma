// MsgPushContext — the decoded envelope fields every decoder may need.
// One unified shape: notice decoders pick from `content`, message decoders
// pick from `body` / `responseHead`. Decoders ignore fields they don't need.

import { protoDecode } from '../../protobuf/decode';
import type { ProtoDecoded } from '../../protobuf/decode';
import {
  PushMsgSchema, MessageBodySchema, ResponseHeadSchema, ContentHeadSchema,
} from '../proto/message';
import type { PacketInfo } from '../../protocol/types';
import type { IdentityService } from '../identity-service';

export type PushMsgBody = ProtoDecoded<typeof MessageBodySchema>;
export type PushMsgResponseHead = ProtoDecoded<typeof ResponseHeadSchema>;
export type PushMsgContentHead = ProtoDecoded<typeof ContentHeadSchema>;

export interface MsgPushHead {
  readonly msgType: number;
  readonly subType: number;
  readonly sequence: number;
  readonly timestamp: number;
  readonly msgId: number;
}

export interface MsgPushContext {
  readonly head: MsgPushHead;
  readonly fromUin: number;
  readonly fromUid: string;
  readonly selfUin: number;
  readonly content: Uint8Array;
  readonly body: PushMsgBody | undefined;
  readonly responseHead: PushMsgResponseHead | undefined;
  readonly identity: IdentityService;
}

export function buildContext(pkt: PacketInfo, identity: IdentityService): MsgPushContext | null {
  if (pkt.body.length === 0) return null;

  const push = protoDecode(Buffer.from(pkt.body), PushMsgSchema);
  if (!push?.message) return null;

  const msg = push.message;
  if (!msg.contentHead) return null;

  const head: MsgPushHead = {
    msgType: msg.contentHead.msgType ?? 0,
    subType: msg.contentHead.subType ?? 0,
    sequence: msg.contentHead.sequence ?? 0,
    timestamp: msg.contentHead.timestamp ?? 0,
    msgId: msg.contentHead.msgId ?? 0,
  };

  let fromUin = 0;
  let fromUid = '';
  if (msg.responseHead) {
    fromUin = msg.responseHead.fromUin ?? 0;
    fromUid = msg.responseHead.fromUid ?? '';
  }

  let selfUin = 0;
  if (pkt.uin) {
    const n = parseInt(pkt.uin, 10);
    if (!isNaN(n)) selfUin = n;
  }

  const content = msg.body?.msgContent ?? new Uint8Array(0);

  return {
    head,
    fromUin,
    fromUid,
    selfUin,
    content,
    body: msg.body,
    responseHead: msg.responseHead,
    identity,
  };
}
