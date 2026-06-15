import type { pb, pb_repeated, uint_32 } from '@snowluma/proton';
import type { PushMsgBody } from './message';

// trpc.msg.register_proxy.RegisterProxy.SsoGetC2cMsg — fetch private (c2c)
// message history from the server by sequence range. Reference: Lagrange.Core
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
