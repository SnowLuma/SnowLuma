// Proton (compile-time) form of bridge/proto/action.ts.
// One-to-one mirror; legacy `*Schema` constants stay alongside for back-compat.

import type { pb, pb_repeated, int_32, uint_32, uint_64, bytes } from '@snowluma/proton';
import type { Elem } from './element';

// ── Routing ─────────────────────────────────────────────────────────

export interface RoutingC2C {
  uin?: pb<1, uint_32>;
  uid?: pb<2, string>;
}

export interface RoutingGroup {
  groupCode?: pb<1, uint_64>;
}

export interface RoutingHead {
  c2c?: pb<1, RoutingC2C>;
  grp?: pb<2, RoutingGroup>;
}

// ── Content Head (for send) ─────────────────────────────────────────

export interface SendContentHead {
  type?:    pb<1, uint_32>;
  subType?: pb<2, uint_32>;
  c2cCmd?:  pb<3, uint_32>;
}

// ── Message Control ─────────────────────────────────────────────────

export interface MessageControl {
  msgFlag?: pb<1, int_32>;
}

// ── RichText (for send — only elems) ────────────────────────────────

export interface SendRichText {
  elems?: pb_repeated<2, Elem>;
}

// ── MessageBody (for send) ──────────────────────────────────────────

export interface SendMessageBody {
  richText?: pb<1, SendRichText>;
}

// ── SendMessageRequest ──────────────────────────────────────────────

export interface SendMessageRequest {
  routingHead?:    pb<1, RoutingHead>;
  contentHead?:    pb<2, SendContentHead>;
  messageBody?:    pb<3, SendMessageBody>;
  clientSequence?: pb<4, uint_32>;
  random?:         pb<5, uint_32>;
  syncCookie?:     pb<6, bytes>;
  via?:            pb<8, uint_32>;
  dataStatist?:    pb<9, uint_32>;
  ctrl?:           pb<12, MessageControl>;
  multiSendSeq?:   pb<14, uint_32>;
}

// ── SendMessageResponse ─────────────────────────────────────────────

export interface SendMessageResponse {
  result?:          pb<1, int_32>;
  errMsg?:          pb<2, string>;
  timestamp1?:      pb<3, uint_32>;
  field10?:         pb<10, uint_32>;
  groupSequence?:   pb<11, uint_32>;
  timestamp2?:      pb<12, uint_32>;
  privateSequence?: pb<14, uint_32>;
}

// ── MentionExtra (for building @mention text element) ───────────────
//
// Same wire shape as element.ts's MentionExtra (which is used for decoding
// inbound mentions) — kept under a distinct name to mark the send-side
// usage, matching the legacy convention.

export interface MentionExtraSend {
  type?:   pb<3, int_32>;
  uin?:    pb<4, uint_32>;
  field5?: pb<5, int_32>;
  uid?:    pb<9, string>;
}

// ── MarkdownData ────────────────────────────────────────────────────

export interface MarkdownData {
  content?: pb<1, string>;
}
