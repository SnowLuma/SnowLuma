import type { PushMsgBody } from './context';

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
