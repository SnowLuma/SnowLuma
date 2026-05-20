// Proton (compile-time) form of bridge/proto/message.ts.
// One-to-one mirror; legacy `*Schema` constants stay alongside for back-compat.

import type { pb, pb_repeated, int_32, uint_32, uint_64, bytes } from '@snowluma/proton';
import type { Elem } from './element';

// ── ResponseHead.Grp ────────────────────────────────────────────────

export interface ResponseGrp {
  groupUin?:   pb<1, uint_32>;
  memberName?: pb<2, string>;
  groupName?:  pb<4, string>;
}

export interface ResponseForward {
  friendName?: pb<6, string>;
}

// ── ResponseHead ────────────────────────────────────────────────────

export interface ResponseHead {
  fromUin?: pb<1, uint_32>;
  fromUid?: pb<2, string>;
  type?:    pb<3, uint_32>;
  sigMap?:  pb<4, uint_32>;
  toUin?:   pb<5, uint_32>;
  toUid?:   pb<6, string>;
  forward?: pb<7, ResponseForward>;
  grp?:     pb<8, ResponseGrp>;
}

// ── ContentHead ─────────────────────────────────────────────────────

export interface ContentHead {
  msgType?:   pb<1, uint_32>;
  subType?:   pb<2, uint_32>;
  divSeq?:    pb<3, uint_32>;
  msgId?:     pb<4, uint_32>;
  sequence?:  pb<5, uint_32>;
  timestamp?: pb<6, uint_32>;
  field7?:    pb<7, uint_64>;
  newId?:     pb<12, uint_64>;
}

// ── Ptt (voice) ─────────────────────────────────────────────────────

export interface Ptt {
  fileType?:     pb<1, uint_32>;
  fileId?:       pb<2, uint_64>;
  fileUuid?:     pb<3, bytes>;
  fileMd5?:      pb<4, bytes>;
  fileName?:     pb<5, string>;
  fileSize?:     pb<6, uint_32>;
  groupFileKey?: pb<10, string>;
  fileKey?:      pb<14, bytes>;
  time?:         pb<19, uint_32>;
  format?:       pb<29, uint_32>;
}

// ── NotOnlineFile (C2C file) ────────────────────────────────────────
//
// Field numbers cross-checked against `dev/Lagrange.Core/.../Component/
// NotOnlineFile.cs`. This same shape is what gets serialised inside
// `FileExtra` (below) and ridden as `MessageBody.msgContent` for c2c
// file sends — fields 9/50/55 are required on send (subcmd=1,
// dangerEvel=0, expireTime=now+7d), the receiver only reads the
// identification slots.

export interface NotOnlineFile {
  fileType?:   pb<1, uint_32>;
  fileUuid?:   pb<3, string>;
  fileMd5?:    pb<4, bytes>;
  fileName?:   pb<5, string>;
  fileSize?:   pb<6, uint_64>;
  subcmd?:     pb<9, uint_32>;
  dangerEvel?: pb<50, uint_32>;
  expireTime?: pb<55, uint_32>;
  fileHash?:   pb<57, string>;
}

// ── RichText ────────────────────────────────────────────────────────

export interface RichText {
  elems?:         pb_repeated<2, Elem>;
  notOnlineFile?: pb<3, NotOnlineFile>;
  ptt?:           pb<4, Ptt>;
}

// ── MessageBody ─────────────────────────────────────────────────────

export interface MessageBody {
  richText?:   pb<1, RichText>;
  msgContent?: pb<2, bytes>;
}

// ── FileExtra (for C2C file in msg_content) ─────────────────────────
//
// `FileExtra { file: NotOnlineFile }` is the wrapper the server expects
// at `MessageBody.msgContent` (per `dev/Lagrange.Core/.../FileExtra.cs`).
// Old code had a parallel `FileExtraInfo` with fileSize=1, fileName=2,
// fileMd5=3, fileUuid=4, fileHash=5 — that schema didn't match the
// wire shape at all (every field was at the wrong tag), which is why
// c2c file messages we received via msgContent silently failed to
// parse, and c2c file messages we sent through `richText.notOnlineFile`
// (also wrong — see SendMessageBody) shipped a payload the recipient
// couldn't render. Consolidating to a single shared `NotOnlineFile`
// (identification fields 1/3/4/5/6/57) fixes both directions.

export interface FileExtra {
  file?: pb<1, NotOnlineFile>;
}

// ── PushMsgBody ─────────────────────────────────────────────────────

export interface PushMsgBody {
  responseHead?: pb<1, ResponseHead>;
  contentHead?:  pb<2, ContentHead>;
  body?:         pb<3, MessageBody>;
}

// ── PushMsg (top-level) ─────────────────────────────────────────────

export interface PushMsg {
  message?: pb<1, PushMsgBody>;
  status?:  pb<3, int_32>;
}
