import type { pb, pb_repeated, uint_32, bool } from '@snowluma/proton';
import type { PushMsgBody } from './message';

// trpc.msg.register_proxy.RegisterProxy.SsoGetGroupMsg — fetch group message
// history from the server by sequence range. Reference: Lagrange.Core
// Internal/Service/Message/GetGroupMessageService.cs + Packets/Message/Action/
// SsoGetGroupMsg(.Response).cs. The response carries the same `PushMsgBody`
// shape as a live OlPush message, so the existing msg-push decoders parse it.

export interface SsoGetGroupMsgInfo {
  groupUin?:      pb<1, uint_32>;
  startSequence?: pb<2, uint_32>;
  endSequence?:   pb<3, uint_32>;
}

export interface SsoGetGroupMsg {
  info?:      pb<1, SsoGetGroupMsgInfo>;
  direction?: pb<2, bool>; // true (Lagrange hard-codes this)
}

export interface SsoGetGroupMsgResponseBody {
  groupUin?:      pb<3, uint_32>;
  startSequence?: pb<4, uint_32>;
  endSequence?:   pb<5, uint_32>;
  messages?:      pb_repeated<6, PushMsgBody>;
}

export interface SsoGetGroupMsgResponse {
  body?: pb<3, SsoGetGroupMsgResponseBody>;
}
