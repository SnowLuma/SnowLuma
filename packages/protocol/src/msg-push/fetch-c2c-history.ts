import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SsoGetC2cMsg, SsoGetC2cMsgResponse } from '@snowluma/proto-defs/get-c2c-msg';
import type { QQEventVariant } from '../events';
import type { IdentityService } from '../identity-service';
import { isBlankMessage, isC2cControlPush } from './blank-filter';
import { buildContextFromMessage } from './context';
import { decodeFriendMessage } from './decoders/friend-message';

export const SSO_GET_C2C_MSG_CMD = 'trpc.msg.register_proxy.RegisterProxy.SsoGetC2cMsg';

type FriendMessage = Extract<QQEventVariant, { kind: 'friend_message' }>;

interface RawSender {
  sendRawPacket(serviceCmd: string, body: Uint8Array, timeoutMs?: number): Promise<SendPacketResult>;
}

/**
 * Fetch one [startSeq, endSeq] window of private (c2c) history from the server
 * via `SsoGetC2cMsg`, decoding each returned message with the regular friend
 * decoder. `friendUid` is the conversation peer's UID. Returns `friend_message`
 * events sorted oldest→newest by sequence. One packet per call — the caller
 * owns chunking/throttling.
 */
export async function fetchC2cMessageRange(
  sender: RawSender,
  identity: IdentityService,
  selfUin: number,
  friendUid: string,
  startSeq: number,
  endSeq: number,
): Promise<FriendMessage[]> {
  if (!friendUid || !(endSeq > 0) || startSeq > endSeq) return [];

  const req = protobuf_encode<SsoGetC2cMsg>({
    friendUid,
    startSequence: startSeq,
    endSequence: endSeq,
  });

  const res = await sender.sendRawPacket(SSO_GET_C2C_MSG_CMD, req);
  if (!res.success || !res.gotResponse || !res.responseData) return [];

  const decoded = protobuf_decode<SsoGetC2cMsgResponse>(res.responseData);
  const messages = decoded?.messages ?? [];

  const out: FriendMessage[] = [];
  for (const msg of messages) {
    const ctx = buildContextFromMessage(msg, selfUin, identity);
    if (!ctx) continue;
    for (const ev of decodeFriendMessage(ctx)) {
      if (ev.kind !== 'friend_message' || ev.msgSeq <= 0) continue;
      // Drop C2C control/system signals and content-less pushes (the "[空消息]"
      // phantom, #102) just as QQ NT does on its roam/history fetch — keep
      // history parity with live (parseMsgPush).
      if (isC2cControlPush(ctx.head) || isBlankMessage(ev.elements, ctx.body)) continue;
      out.push(ev);
    }
  }
  out.sort((a, b) => a.msgSeq - b.msgSeq);
  return out;
}
