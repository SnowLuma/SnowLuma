// Proto schemas for message envelopes (PushMsg).
// Port of src/bridge/include/bridge/proto/message.h

import type { ProtoSchema } from '../../protobuf/decode';
import { ElemSchema } from './element';

// --- ResponseHead.Grp ---

export const ResponseGrpSchema = {
  groupUin:   { field: 1, type: 'uint32' as const },
  memberName: { field: 2, type: 'string' as const },
  groupName:  { field: 4, type: 'string' as const },
} satisfies ProtoSchema;

export const ResponseForwardSchema = {
  friendName: { field: 6, type: 'string' as const },
} satisfies ProtoSchema;

// --- ResponseHead ---

export const ResponseHeadSchema = {
  fromUin:  { field: 1, type: 'uint32' as const },
  fromUid:  { field: 2, type: 'string' as const },
  type:     { field: 3, type: 'uint32' as const },
  sigMap:   { field: 4, type: 'uint32' as const },
  toUin:    { field: 5, type: 'uint32' as const },
  toUid:    { field: 6, type: 'string' as const },
  forward:  { field: 7, type: 'message' as const, schema: ResponseForwardSchema },
  grp:      { field: 8, type: 'message' as const, schema: ResponseGrpSchema },
} satisfies ProtoSchema;

// --- ContentHead ---

export const ContentHeadSchema = {
  msgType:    { field: 1, type: 'uint32' as const },
  subType:    { field: 2, type: 'uint32' as const },
  divSeq:     { field: 3, type: 'uint32' as const },
  msgId:      { field: 4, type: 'uint32' as const },
  sequence:   { field: 5, type: 'uint32' as const },
  timestamp:  { field: 6, type: 'uint32' as const },
  field7:     { field: 7, type: 'uint64' as const },
  newId:      { field: 12, type: 'uint64' as const },
} satisfies ProtoSchema;

// --- Ptt (voice) ---

export const PttSchema = {
  fileType:     { field: 1, type: 'uint32' as const },
  fileId:       { field: 2, type: 'uint64' as const },
  fileUuid:     { field: 3, type: 'bytes' as const },
  fileMd5:      { field: 4, type: 'bytes' as const },
  fileName:     { field: 5, type: 'string' as const },
  fileSize:     { field: 6, type: 'uint32' as const },
  groupFileKey: { field: 10, type: 'string' as const },
  fileKey:      { field: 14, type: 'bytes' as const },
  time:         { field: 19, type: 'uint32' as const },
  format:       { field: 29, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- NotOnlineFile (C2C file) ---

// Field numbers per `dev/Lagrange.Core/.../Component/NotOnlineFile.cs`.
// fields 9 (subcmd), 50 (dangerEvel), 55 (expireTime) are required
// on c2c file SEND (the receiver ignores them); the identification
// fields (1/3/4/5/6/57) are read both directions.
export const NotOnlineFileSchema = {
  fileType:   { field: 1, type: 'uint32' as const },
  fileUuid:   { field: 3, type: 'string' as const },
  fileMd5:    { field: 4, type: 'bytes' as const },
  fileName:   { field: 5, type: 'string' as const },
  fileSize:   { field: 6, type: 'uint64' as const },
  subcmd:     { field: 9, type: 'uint32' as const },
  dangerEvel: { field: 50, type: 'uint32' as const },
  expireTime: { field: 55, type: 'uint32' as const },
  fileHash:   { field: 57, type: 'string' as const },
} satisfies ProtoSchema;

// --- RichText ---

export const RichTextSchema = {
  elems:          { field: 2, type: 'repeated_message' as const, schema: ElemSchema },
  notOnlineFile:  { field: 3, type: 'message' as const, schema: NotOnlineFileSchema },
  ptt:            { field: 4, type: 'message' as const, schema: PttSchema },
} satisfies ProtoSchema;

// --- MessageBody ---

export const MessageBodySchema = {
  richText:   { field: 1, type: 'message' as const, schema: RichTextSchema },
  msgContent: { field: 2, type: 'bytes' as const },
} satisfies ProtoSchema;

// --- FileExtra (for C2C file in msg_content) ---
//
// `FileExtra { file: NotOnlineFile }` is the wrapper QQ-NT actually
// uses at `MessageBody.msgContent` for c2c file sends. The previous
// `FileExtraInfoSchema` had fileSize=1, fileName=2, fileMd5=3,
// fileUuid=4, fileHash=5 — every field at the wrong tag, so received
// c2c-file payloads silently failed to parse. Consolidated to the
// shared `NotOnlineFileSchema` (Lagrange.Core's `FileExtra.cs` does
// the same — `[ProtoMember(1)] public NotOnlineFile? File`).

export const FileExtraSchema = {
  file: { field: 1, type: 'message' as const, schema: NotOnlineFileSchema },
} satisfies ProtoSchema;

// --- PushMsgBody ---

export const PushMsgBodySchema = {
  responseHead: { field: 1, type: 'message' as const, schema: ResponseHeadSchema },
  contentHead:  { field: 2, type: 'message' as const, schema: ContentHeadSchema },
  body:         { field: 3, type: 'message' as const, schema: MessageBodySchema },
} satisfies ProtoSchema;

// --- PushMsg (top-level) ---

export const PushMsgSchema = {
  message:  { field: 1, type: 'message' as const, schema: PushMsgBodySchema },
  status:   { field: 3, type: 'int32' as const },
} satisfies ProtoSchema;
