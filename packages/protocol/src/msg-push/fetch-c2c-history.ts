import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { createLogger } from '@snowluma/common/logger';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
  SsoGetC2cMsg,
  SsoGetC2cMsgResponse,
  SsoGetRoamMsg,
  SsoGetRoamMsgResponse,
} from '@snowluma/proto-defs/get-c2c-msg';
import type { PushMsgBody } from '@snowluma/proto-defs/message';
import type { QQEventVariant } from '../events';
import type { IdentityService } from '../identity-service';
import { isBlankMessage, isC2cControlPush } from './blank-filter';
import { buildContextFromMessage } from './context';
import { decodeFriendMessage } from './decoders/friend-message';

export const SSO_GET_C2C_MSG_CMD = 'trpc.msg.register_proxy.RegisterProxy.SsoGetC2cMsg';
export const SSO_GET_ROAM_MSG_CMD = 'trpc.msg.register_proxy.RegisterProxy.SsoGetRoamMsg';

const log = createLogger('MsgPush.C2CHistory');

type FriendMessage = Extract<QQEventVariant, { kind: 'friend_message' }>;

interface RawSender {
  sendRawPacket(serviceCmd: string, body: Uint8Array, timeoutMs?: number): Promise<SendPacketResult>;
}

export interface C2cRoamPage {
  messages: FriendMessage[];
  cursor: { time: number; random: number };
}

function requirePacketResponse(result: SendPacketResult, command: string): Uint8Array {
  if (!result.success) {
    throw new Error(`${command} transport failed: ${result.errorMessage || 'unknown transport error'}`);
  }
  if (!result.gotResponse || !result.responseData || result.responseData.length === 0) {
    throw new Error(`${command} response is empty`);
  }
  return result.responseData;
}

function decodeC2cMessages(
  messages: readonly PushMsgBody[],
  identity: IdentityService,
  selfUin: number,
  source: string,
): FriendMessage[] {
  const out: FriendMessage[] = [];
  for (const msg of messages) {
    const ctx = buildContextFromMessage(msg, selfUin, identity);
    if (!ctx) {
      throw new Error(`${source} response contains a message without a content head`);
    }
    if (isC2cControlPush(ctx.head)) continue;
    for (const ev of decodeFriendMessage(ctx)) {
      if (ev.kind !== 'friend_message') continue;
      if (isBlankMessage(ev.elements, ctx.body)) continue;
      if (ev.sequenceAuthoritative === false || !ev.ntMsgSeq || ev.ntMsgSeq <= 0) {
        throw new Error(
          `${source} message is missing the canonical NT sequence `
          + `(clientSeq=${ev.clientSeq ?? ev.msgSeq} from=${ev.senderUin} time=${ev.time})`,
        );
      }
      out.push(ev);
    }
  }
  return out;
}

/**
 * Fetch one [startSeq, endSeq] NT-sequence window of private (c2c) history from
 * the server via `SsoGetC2cMsg`, decoding each returned message with the regular friend
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
  const decoded = protobuf_decode<SsoGetC2cMsgResponse>(
    requirePacketResponse(res, 'SsoGetC2cMsg'),
  );
  const messages = decoded?.messages ?? [];
  const out = decodeC2cMessages(messages, identity, selfUin, 'SsoGetC2cMsg');
  out.sort((a, b) => (a.ntMsgSeq ?? 0) - (b.ntMsgSeq ?? 0));
  log.debug(
    'SsoGetC2cMsg decoded friend=%s range=%d-%d wire=%d usable=%d',
    friendUid,
    startSeq,
    endSeq,
    messages.length,
    out.length,
  );
  return out;
}

/**
 * Fetch one timestamp-cursor page of C2C roaming history. QQ uses this endpoint
 * for an unanchored latest page; it returns messages from both participants.
 */
export async function fetchC2cRoamMessagePage(
  sender: RawSender,
  identity: IdentityService,
  selfUin: number,
  friendUid: string,
  beforeTime: number,
  count: number,
  beforeRandom = 0,
): Promise<C2cRoamPage> {
  if (!friendUid) throw new Error('SsoGetRoamMsg friend uid is required');
  if (!Number.isSafeInteger(beforeTime) || beforeTime < 0 || beforeTime > 0xffff_ffff) {
    throw new Error(`SsoGetRoamMsg cursor time is invalid: ${String(beforeTime)}`);
  }
  if (!Number.isSafeInteger(beforeRandom) || beforeRandom < 0 || beforeRandom > 0xffff_ffff) {
    throw new Error(`SsoGetRoamMsg cursor random is invalid: ${String(beforeRandom)}`);
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 200) {
    throw new Error(`SsoGetRoamMsg count is invalid: ${String(count)}`);
  }

  const req = protobuf_encode<SsoGetRoamMsg>({
    friendUid,
    time: beforeTime,
    random: beforeRandom,
    count,
    direction: true,
  });
  const result = await sender.sendRawPacket(SSO_GET_ROAM_MSG_CMD, req);
  const response = protobuf_decode<SsoGetRoamMsgResponse>(
    requirePacketResponse(result, 'SsoGetRoamMsg'),
  );
  if (response.friendUid && response.friendUid !== friendUid) {
    throw new Error(`SsoGetRoamMsg response friend uid mismatch: ${response.friendUid}`);
  }

  const wireMessages = response.messages ?? [];
  const messages = decodeC2cMessages(wireMessages, identity, selfUin, 'SsoGetRoamMsg');
  messages.sort((a, b) => (a.ntMsgSeq ?? 0) - (b.ntMsgSeq ?? 0) || a.time - b.time);
  const cursor = { time: response.timestamp ?? 0, random: response.random ?? 0 };
  log.debug(
    'SsoGetRoamMsg decoded friend=%s before=%d/%d count=%d wire=%d usable=%d next=%d/%d',
    friendUid,
    beforeTime,
    beforeRandom,
    count,
    wireMessages.length,
    messages.length,
    cursor.time,
    cursor.random,
  );
  return { messages, cursor };
}
