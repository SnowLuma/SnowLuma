// Proton (compile-time) form of the long-message schemas.
//
// One-to-one mirror of `bridge/proto/longmsg.ts`. All 12 schemas are now
// migrated — the three (`LongMsgContent` / `LongMsgAction` / `LongMsgResult`)
// that reach into `PushMsgBody` resolve via the proton-form `message.ts`
// migration alongside this file.

import type { pb, pb_repeated, uint_32, bool, bytes } from '@snowluma/proton';
import type { PushMsgBody } from './message';

export interface LongMsgUid {
  uid?: pb<2, string>;
}

export interface LongMsgSettings {
  field1?: pb<1, uint_32>;
  field2?: pb<2, uint_32>;
  field3?: pb<3, uint_32>;
  field4?: pb<4, uint_32>;
}

export interface SendLongMsgInfo {
  type?:     pb<1, uint_32>;
  uid?:      pb<2, LongMsgUid>;
  groupUin?: pb<3, uint_32>;
  payload?:  pb<4, bytes>;
}

export interface SendLongMsgReq {
  info?:     pb<2, SendLongMsgInfo>;
  settings?: pb<15, LongMsgSettings>;
}

export interface SendLongMsgRespResult {
  resId?: pb<3, string>;
}

export interface SendLongMsgResp {
  result?:   pb<2, SendLongMsgRespResult>;
  settings?: pb<15, LongMsgSettings>;
}

export interface RecvLongMsgInfo {
  uid?:     pb<1, LongMsgUid>;
  resId?:   pb<2, string>;
  acquire?: pb<3, bool>;
}

export interface RecvLongMsgReq {
  info?:     pb<1, RecvLongMsgInfo>;
  settings?: pb<15, LongMsgSettings>;
}

export interface RecvLongMsgRespResult {
  resId?:   pb<3, string>;
  payload?: pb<4, bytes>;
}

export interface RecvLongMsgResp {
  result?:   pb<1, RecvLongMsgRespResult>;
  settings?: pb<15, LongMsgSettings>;
}

// ── Schemas that reach into PushMsgBody (via message.ts) ────────────

export interface LongMsgContent {
  msgBody?: pb_repeated<1, PushMsgBody>;
}

export interface LongMsgAction {
  actionCommand?: pb<1, string>;
  actionData?:    pb<2, LongMsgContent>;
}

export interface LongMsgResult {
  action?: pb_repeated<2, LongMsgAction>;
}
