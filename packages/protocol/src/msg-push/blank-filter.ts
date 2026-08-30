import { hexPreview } from '@snowluma/common/hex';
import { createLogger } from '@snowluma/common/logger';
import type { Elem } from '@snowluma/proto-defs/element';
import type { MsgPushHead, PushMsgBody } from './context';
import { hasDecodableContent } from './rich-body-decoder';

const log = createLogger('MsgPush');

// C2C-family message types (private 166, temp 141, and 167) whose pushes QQ NT
// classifies by `c2c_cmd`. RE: `long_cnn_msg_mgr.cc::OnRecvSysMsg` gates on
// exactly this set (svr_msg_type-141 bitmask 0x6000001 → {141,166,167}).
const C2C_CONTROL_TYPES = new Set<number>([141, 166, 167]);

// `c2c_cmd` values QQ NT routes as system/control signals (via OnRecvSysMsg) and
// excludes from the chat list — never shown as a bubble. RE: the static lookup
// table @0xA13DF0 consulted by `msg_header_codec_helper.cc::DecodeRoutingHead`
// (sub_3B42650). These carry no chat content by design; the group-invite "[空消息]"
// phantom (#102) is one of them.
const C2C_CONTROL_CMDS = new Set<number>([1, 73, 75, 129, 131, 133, 135, 192]);

export type MessageSurvival = 'drop-control' | 'drop-blank' | 'keep-undecoded' | 'keep';

/**
 * Whether a push is a C2C control/system signal that QQ NT never renders as a
 * chat message (it dispatches it through `OnRecvSysMsg` instead). Matched by
 * `(msgType, c2cCmd)` exactly as the official client's header codec does, so it
 * catches these even on the rare occasion they carry junk content that would
 * otherwise decode to a stray element. History may skip these before decode;
 * the post-decode filter still returns `drop-control` for the same decision.
 */
export function isC2cControlPush(head: Pick<MsgPushHead, 'msgType' | 'c2cCmd'>): boolean {
  return C2C_CONTROL_TYPES.has(head.msgType) && C2C_CONTROL_CMDS.has(head.c2cCmd);
}

/**
 * A message-kind event is "blank" — the "[空消息]" phantom from #102 — when it
 * decoded to zero elements AND its body carried nothing decodable.
 */
export function isBlankMessage(
  elements: readonly unknown[],
  body: PushMsgBody | undefined,
): boolean {
  return elements.length === 0 && !hasDecodableContent(body);
}

/**
 * Decoder-after bubble decision for friend / group / temp messages.
 * Control drops even when a body decoded to elements. Blank drops only when
 * there is nothing to decode. A body that had content but decoded to zero
 * elements is keep-undecoded, not blank.
 */
export function classifyMessageSurvival(
  head: Pick<MsgPushHead, 'msgType' | 'c2cCmd'>,
  elements: readonly unknown[],
  body: PushMsgBody | undefined,
): MessageSurvival {
  if (isC2cControlPush(head)) return 'drop-control';
  if (elements.length !== 0) return 'keep';
  if (hasDecodableContent(body)) return 'keep-undecoded';
  return 'drop-blank';
}

/** Summarise a body that decoded to zero elements despite carrying content. */
export function describeUndecodedBody(body: PushMsgBody | undefined): string {
  const elems = (body?.richText?.elems ?? []) as Elem[];
  const parts = elems.map((e) => {
    if (e.commonElem) {
      const ce = e.commonElem;
      const pb = ce.pbElem && ce.pbElem.length > 0 ? ` pbElem=${hexPreview(ce.pbElem, 256)}` : '';
      return `commonElem(svc=${ce.serviceType ?? 0},biz=${ce.businessType ?? 0})${pb}`;
    }
    const keys = Object.keys(e).filter((k) => (e as Record<string, unknown>)[k] != null);
    return keys.join('+') || '(empty)';
  });
  const extras: string[] = [];
  if (body?.richText?.ptt) extras.push('ptt');
  if (body?.richText?.notOnlineFile) extras.push('notOnlineFile');
  if (body?.msgContent && body.msgContent.length > 0) {
    extras.push(`msgContent=${hexPreview(body.msgContent, 256)}`);
  }
  return `elems=[${parts.join('; ')}]${extras.length ? ` ${extras.join(' ')}` : ''}`;
}

/** Keep when the message should appear as a bubble. Warns on keep-undecoded. */
export function keepDecodedMessage(
  head: Pick<MsgPushHead, 'msgType' | 'c2cCmd' | 'sequence' | 'subType'>,
  elements: readonly unknown[],
  body: PushMsgBody | undefined,
  kind: string,
  fromUin: number,
): boolean {
  const survival = classifyMessageSurvival(head, elements, body);
  if (survival === 'drop-control' || survival === 'drop-blank') return false;
  if (survival === 'keep-undecoded') {
    warnUndecodedMessage({
      kind,
      sequence: head.sequence,
      fromUin,
      msgType: head.msgType,
      subType: head.subType,
      body,
    });
  }
  return true;
}

export function warnUndecodedMessage(info: {
  kind: string;
  sequence: number;
  fromUin: number;
  msgType: number;
  subType: number;
  body: PushMsgBody | undefined;
}): void {
  log.warn(
    'message had content but decoded to 0 elements — missing decoder? (kind=%s seq=%d from=%d msgType=%d/%d): %s',
    info.kind,
    info.sequence,
    info.fromUin,
    info.msgType,
    info.subType,
    describeUndecodedBody(info.body),
  );
}
