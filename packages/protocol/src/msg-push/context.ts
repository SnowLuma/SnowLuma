import { protobuf_decode } from '@snowluma/proton';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { IdentityService } from '../identity-service';
import type { ContentHead, MessageBody, PushMsg, PushMsgBody as ProtoMessage, ResponseHead } from '@snowluma/proto-defs/message';

export type PushMsgBody = MessageBody;
export type PushMsgResponseHead = ResponseHead;
export type PushMsgContentHead = ContentHead;

export interface MsgPushHead {
  readonly msgType: number;
  readonly subType: number;
  /** C2C command (`contentHead` field 3). Discriminates control pushes — see
   *  `isC2cControlPush` in ./blank-filter. */
  readonly c2cCmd: number;
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

  // `pkt.body` is already a `Uint8Array` (see `PacketInfo` in
  // @snowluma/common/protocol-types). The legacy `Buffer.from(uint8)`
  // wrap was a no-op copy — Buffer is a Uint8Array subclass and
  // proton's decoder accepts the parent type directly. Dropping the
  // wrap saves one allocation per incoming push packet.
  const push = protobuf_decode<PushMsg>(pkt.body);
  if (!push?.message) return null;

  let selfUin = 0;
  if (pkt.uin) {
    const n = parseInt(pkt.uin, 10);
    if (!isNaN(n)) selfUin = n;
  }

  return buildContextFromMessage(push.message, selfUin, identity);
}

/**
 * Build a push context from an already-extracted per-message struct (the same
 * `PushMsgBody` shape that `PushMsg.message` carries). Used both by
 * {@link buildContext} (live OlPush) and by the group-history fetch, whose
 * `SsoGetGroupMsgResponse.body.messages` are these same structs — so the
 * regular msg-push decoders parse fetched history unchanged.
 */
export function buildContextFromMessage(
  msg: ProtoMessage,
  selfUin: number,
  identity: IdentityService,
): MsgPushContext | null {
  if (!msg.contentHead) return null;

  const head: MsgPushHead = {
    msgType: msg.contentHead.msgType ?? 0,
    subType: msg.contentHead.subType ?? 0,
    c2cCmd: msg.contentHead.c2cCmd ?? 0,
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
