import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SsoGetGroupMsg, SsoGetGroupMsgResponse } from '@snowluma/proto-defs/get-group-msg';
import type { QQEventVariant } from '../events';
import type { IdentityService } from '../identity-service';
import { isBlankMessage } from './blank-filter';
import { buildContextFromMessage } from './context';
import { decodeGroupMessage } from './decoders/group-message';

export const SSO_GET_GROUP_MSG_CMD = 'trpc.msg.register_proxy.RegisterProxy.SsoGetGroupMsg';

type GroupMessage = Extract<QQEventVariant, { kind: 'group_message' }>;

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
  if (!res.success || !res.gotResponse || !res.responseData) return [];

  const decoded = protobuf_decode<SsoGetGroupMsgResponse>(res.responseData);
  const messages = decoded?.body?.messages ?? [];

  const out: GroupMessage[] = [];
  for (const msg of messages) {
    const ctx = buildContextFromMessage(msg, selfUin, identity);
    if (!ctx) continue;
    for (const ev of decodeGroupMessage(ctx)) {
      if (ev.kind !== 'group_message' || ev.msgSeq <= 0) continue;
      // Drop content-less control pushes (the "[空消息]" phantom, #102) just as
      // QQ NT does on its group roam/history fetch — keep history parity with live.
      if (isBlankMessage(ev.elements, ctx.body)) continue;
      out.push(ev);
    }
  }
  out.sort((a, b) => a.msgSeq - b.msgSeq);
  return out;
}
