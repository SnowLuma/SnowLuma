import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { createLogger } from '@snowluma/common/logger';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SsoGetGroupMsg, SsoGetGroupMsgResponse } from '@snowluma/proto-defs/get-group-msg';
import type { QQEventVariant } from '../events';
import type { IdentityService } from '../identity-service';
import { keepDecodedMessage } from './blank-filter';
import { buildContextFromMessage } from './context';
import { decodeGroupMessage } from './decoders/group-message';
import { requirePacketResponse } from './packet-response';

export const SSO_GET_GROUP_MSG_CMD = 'trpc.msg.register_proxy.RegisterProxy.SsoGetGroupMsg';

type GroupMessage = Extract<QQEventVariant, { kind: 'group_message' }>;

const log = createLogger('MsgPush.GroupHistory');

interface RawSender {
  sendRawPacket(serviceCmd: string, body: Uint8Array, timeoutMs?: number): Promise<SendPacketResult>;
}

/**
 * Fetch one [startSeq, endSeq] window of group history from the server via
 * `SsoGetGroupMsg`, decoding each returned message with the regular group
 * decoder. Returns `group_message` events sorted oldest→newest by sequence.
 *
 * One packet per call — the caller (MessageApi.getGroupHistory) owns the
 * chunking/throttling so the server's frequency limits aren't tripped.
 */
export async function fetchGroupMessageRange(
  sender: RawSender,
  identity: IdentityService,
  selfUin: number,
  groupUin: number,
  startSeq: number,
  endSeq: number,
): Promise<GroupMessage[]> {
  if (!(groupUin > 0) || !(endSeq > 0) || startSeq > endSeq) return [];

  const req = protobuf_encode<SsoGetGroupMsg>({
    info: { groupUin, startSequence: startSeq, endSequence: endSeq },
    direction: true,
  });

  const res = await sender.sendRawPacket(SSO_GET_GROUP_MSG_CMD, req);
  const decoded = protobuf_decode<SsoGetGroupMsgResponse>(
    requirePacketResponse(res, 'SsoGetGroupMsg'),
  );
  const messages = decoded?.body?.messages ?? [];

  const out: GroupMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    const ctx = buildContextFromMessage(msg, selfUin, identity);
    if (!ctx) {
      throw new Error(
        `SsoGetGroupMsg response message ${index} has no content head `
        + `(group=${groupUin} range=${startSeq}-${endSeq})`,
      );
    }
    // QQ NT turns deleted/body-null roam entries into MsgType::kNull and its
    // FilterBlankSeqsMsg pass removes them before exposing history to callers.
    // SsoGetGroupMsg still carries a localized placeholder body for some of
    // those entries (for example "[已删除]"), so the ordinary content-less
    // filter below cannot recognize them. On the wire these null records have
    // neither a sender nor a timestamp; require both structural absences rather
    // than matching localized text so a real message is never language-filtered.
    if (ctx.fromUin <= 0 && ctx.head.timestamp <= 0) {
      log.debug(
        'dropping QQ null roam record: group=%d seq=%d msgId=%d',
        groupUin,
        ctx.head.sequence,
        ctx.head.msgId,
      );
      continue;
    }
    for (const ev of decodeGroupMessage(ctx)) {
      if (ev.kind !== 'group_message') {
        throw new Error(
          `SsoGetGroupMsg response message ${index} decoded as ${ev.kind} `
          + `(group=${groupUin} range=${startSeq}-${endSeq})`,
        );
      }
      if (!Number.isSafeInteger(ev.msgSeq) || ev.msgSeq <= 0) {
        throw new Error(
          `SsoGetGroupMsg response message ${index} has invalid sequence ${String(ev.msgSeq)} `
          + `(group=${groupUin} range=${startSeq}-${endSeq})`,
        );
      }
      if (ev.groupId !== groupUin) {
        throw new Error(
          `SsoGetGroupMsg response message ${index} belongs to group ${ev.groupId} `
          + `(expected=${groupUin} range=${startSeq}-${endSeq})`,
        );
      }
      if (!keepDecodedMessage(ctx.head, ev.elements, ctx.body, ev.kind, ctx.fromUin)) continue;
      out.push(ev);
    }
  }
  out.sort((a, b) => a.msgSeq - b.msgSeq);
  return out;
}
