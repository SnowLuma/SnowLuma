import type { MsgPushHead, PushMsgBody } from './context';

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

/**
 * Whether a push is a C2C control/system signal that QQ NT never renders as a
 * chat message (it dispatches it through `OnRecvSysMsg` instead). Matched by
 * `(msgType, c2cCmd)` exactly as the official client's header codec does, so it
 * catches these even on the rare occasion they carry junk content that would
 * otherwise decode to a stray element. The precise complement to
 * {@link isBlankMessage}, which only catches the content-less case.
 */
export function isC2cControlPush(head: Pick<MsgPushHead, 'msgType' | 'c2cCmd'>): boolean {
  return C2C_CONTROL_TYPES.has(head.msgType) && C2C_CONTROL_CMDS.has(head.c2cCmd);
}

/**
 * Whether a push body carries anything {@link decodeRichBody} could turn into an
 * element: source `richText.elems`, a voice (`ptt`), a c2c file
 * (`notOnlineFile`), or serialised `msgContent` file metadata. Mirrors exactly
 * what the rich-body decoder reads. A body with none of these is a genuinely
 * content-less control push, not an element type we merely fail to decode.
 */
export function bodyHasDecodableContent(body: PushMsgBody | undefined): boolean {
  const rt = body?.richText;
  if (rt) {
    if (rt.elems && rt.elems.length > 0) return true;
    if (rt.ptt || rt.notOnlineFile) return true;
  }
  return !!(body?.msgContent && body.msgContent.length > 0);
}

/**
 * A message-kind event is "blank" — the "[空消息]" phantom from #102 — when it
 * decoded to zero elements AND its body carried nothing decodable. These are
 * QQ's content-less C2C control/system pushes (msgType 166/141/167 carrying a
 * `c2c_cmd`, routed by the official client through `OnRecvSysMsg` rather than
 * shown as a bubble).
 *
 * QQ NT drops such records before the UI ever sees them, in BOTH the live push
 * path and the history (roam) fetch path — RE of `wrapper.linux.node`:
 *   - live/roam C2C: `c2c_roam_msg_mgr.cc::FilterBlankMsgAndRetryFetch`
 *   - group roam:    `group_roam_msg_worker.cc::FilterBlankSeqsMsg`
 * So we mirror it everywhere a message event is produced — live (`parseMsgPush`)
 * and history (`fetchC2cMessageRange` / `fetchGroupMessageRange`).
 *
 * NOTE: a body that DID carry content but still decoded to zero elements is a
 * missing decoder, not a blank message — this returns false for that case so
 * the caller can keep (and warn about) it rather than silently dropping content.
 */
export function isBlankMessage(
  elements: readonly unknown[],
  body: PushMsgBody | undefined,
): boolean {
  return elements.length === 0 && !bodyHasDecodableContent(body);
}
