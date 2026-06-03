import type { pb, uint_32, uint_64, bytes } from '@snowluma/proton';

/**
 * Voice-to-text (语音转文字) request/response protobufs for the
 * `pttTrans.TransC2CPttReq` / `pttTrans.TransGroupPttReq` SSO commands.
 *
 * Reverse-engineered from QQ-NT `wrapper.node` (macOS 9.9.x) —
 * `im_core/msg/ptt/ptt_trans_worker.cc` (`EncodeC2CPtt` / `EncodeTroopPtt`
 * build the request, `OnTranslateResp` decodes the response). The wire shape
 * here is RE-derived and NOT yet verified against a live server: the numeric
 * field tags are read straight from the encoder, but the length-delimited
 * fields (uuid / md5) and the response `text` tag should be confirmed with a
 * single live capture before relying on them.
 *
 * Flow: send Trans{C2C,Group}PttReq → response carries the text inline when
 * transcription is already done; when it's empty the server transcribes
 * asynchronously (no dedicated push command exists — see NotifyTransUpdate),
 * so the caller re-sends with backoff until the text arrives or it times out.
 */

/** Source ptt-element field (NT internal tag) noted in the comment after each. */
export interface C2CPttTransItem {
  msgId?: pb<1, uint_64>;
  senderUin?: pb<2, uint_64>;
  receiverUin?: pb<3, uint_64>;
  uuid?: pb<4, string>;      // element 45503 (c2c ptt uuid)
  duration?: pb<5, uint_32>;    // element 45906 (seconds)
  size?: pb<6, uint_32>;        // element 45405 (bytes)
  format?: pb<7, uint_32>;      // element 45907 (voice codec)
  eventType?: pb<8, uint_32>;   // element 45921
  md5?: pb<9, bytes>;           // element 45406 (raw 16-byte md5)
}

export interface GroupPttTransItem {
  msgId?: pb<1, uint_64>;
  senderUin?: pb<2, uint_64>;
  groupUin?: pb<3, uint_64>;
  fileId?: pb<4, uint_32>;      // element 45903 (group ptt numeric file id)
  md5?: pb<5, bytes>;           // element 45406
  duration?: pb<6, uint_32>;    // element 45906
  size?: pb<7, uint_32>;        // element 45405
  format?: pb<8, uint_32>;      // element 45907
  uuid?: pb<9, string>;      // element 45503
  eventType?: pb<10, uint_32>;  // element 45921
  ext?: pb<11, uint_32>;        // element 49202 (optional)
}

/**
 * Outer request. `type` selects the scene (1 = group, 2 = c2c) and only the
 * matching item is populated — group at field 2, c2c at field 3.
 */
export interface PttTransReq {
  type?: pb<1, uint_32>;
  groupItem?: pb<2, GroupPttTransItem>;
  c2cItem?: pb<3, C2CPttTransItem>;
}

/** Per-scene result. `errCode` 0 = ok; `text` carries the recognised speech. */
export interface C2CPttTransResult {
  errCode?: pb<2, uint_32>;
  text?: pb<8, string>;      // VERIFY LIVE: text tag from OnTranslateResp
}

export interface GroupPttTransResult {
  errCode?: pb<2, uint_32>;
  text?: pb<9, string>;      // VERIFY LIVE: text tag from OnTranslateResp
}

/**
 * Outer response. `type` echoes the scene; result is at field 2 (group) /
 * field 3 (c2c). An empty `text` with `errCode == 0` means "transcribing,
 * retry later".
 */
export interface PttTransResp {
  type?: pb<1, uint_32>;
  groupResult?: pb<2, GroupPttTransResult>;
  c2cResult?: pb<3, C2CPttTransResult>;
}

/**
 * Async result push (Event 0x210 subType 61), sent after the request once the
 * server finishes transcribing. **Live-verified** against a real push: the
 * outer carries a single result item at field 2; the item echoes the request
 * `msgId` at field 1 (the correlation key) and the recognised text at field 8.
 */
export interface PttTransPushItem {
  msgId?: pb<1, uint_64>;       // echoes the request msgId — correlation key
  text?: pb<8, string>;         // recognised text
  senderUin?: pb<9, uint_64>;
  receiverUin?: pb<10, uint_64>;
  uuid?: pb<13, string>;
}

export interface PttTransPush {
  field1?: pb<1, uint_32>;
  item?: pb<2, PttTransPushItem>;
}
