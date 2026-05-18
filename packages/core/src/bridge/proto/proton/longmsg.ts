// Proton (compile-time) form of the long-message schemas.
//
// Mirror of the self-contained subset of `bridge/proto/longmsg.ts`. Only the
// schemas that DON'T reach into `PushMsgBodySchema` (and thus into element.ts)
// are migrated here — `LongMsgContent` / `LongMsgAction` / `LongMsgResult`
// stay on the legacy runtime API until message.ts + element.ts get migrated.
//
// This file is the proof-of-concept target for the @snowluma/proton plugin.
// The parity test at `tests/proton-parity.test.ts` asserts that proton's
// generated codec produces the exact same wire bytes as `protoEncode`.

import type { pb, uint_32, bool, bytes } from '@snowluma/proton';

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
