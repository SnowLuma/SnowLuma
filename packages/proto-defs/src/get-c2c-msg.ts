import type { pb, pb_repeated, uint_32, bool } from '@snowluma/proton';
import type { PushMsgBody } from './message';

// trpc.msg.register_proxy.RegisterProxy.SsoGetC2cMsg — fetch private (c2c)
// message history from the server by conversation-wide NT sequence range.
// Reference: Lagrange.Core
// Internal/Service/Message/GetC2cMessageService.cs + Packets/Message/Action/
// SsoGetC2cMsg(.Response).cs. The peer is the friend's UID (not uin); the
// response carries the same `PushMsgBody` shape as a live message.

export interface SsoGetC2cMsg {
  friendUid?:     pb<2, string>;
  startSequence?: pb<3, uint_32>;
  endSequence?:   pb<4, uint_32>;
}

export interface SsoGetC2cMsgResponse {
  friendUid?: pb<4, string>;
  messages?:  pb_repeated<7, PushMsgBody>;
}

// trpc.msg.register_proxy.RegisterProxy.SsoGetRoamMsg — fetch private
// history before a timestamp cursor. This is QQ's latest-page C2C history
// endpoint; unlike SsoGetC2cMsg it does not require a locally known sequence.
export interface SsoGetRoamMsg {
  friendUid?: pb<1, string>;
  time?:      pb<2, uint_32>;
  random?:    pb<3, uint_32>;
  count?:     pb<4, uint_32>;
  direction?: pb<5, bool>;
}

export interface SsoGetRoamMsgResponse {
  friendUid?: pb<3, string>;
  timestamp?: pb<5, uint_32>;
  random?:    pb<6, uint_32>;
  messages?:  pb_repeated<7, PushMsgBody>;
}
