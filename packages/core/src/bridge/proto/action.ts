import type { ProtoSchema } from '../../protobuf/decode';
import { ElemSchema } from './element';

// --- Routing ---

export const RoutingC2CSchema = {
  uin: { field: 1, type: 'uint32' as const },
  uid: { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const RoutingGroupSchema = {
  groupCode: { field: 1, type: 'uint64' as const },
} satisfies ProtoSchema;

// `Trans0x211` is the c2c-file scene's routing header (Lagrange.Core
// `Routing/Trans0X211.cs`). See proton/action.ts:RoutingTrans0x211
// for the rationale — c2c file sends *must* route through this slot,
// not `c2c`, or the server rejects them.
export const RoutingTrans0x211Schema = {
  toUin: { field: 1, type: 'uint64' as const },
  ccCmd: { field: 2, type: 'uint32' as const },
  uid:   { field: 8, type: 'string' as const },
} satisfies ProtoSchema;

export const RoutingHeadSchema = {
  c2c:        { field: 1, type: 'message' as const, schema: RoutingC2CSchema },
  grp:        { field: 2, type: 'message' as const, schema: RoutingGroupSchema },
  trans0x211: { field: 15, type: 'message' as const, schema: RoutingTrans0x211Schema },
} satisfies ProtoSchema;

// --- Content Head (for send) ---

export const SendContentHeadSchema = {
  type:    { field: 1, type: 'uint32' as const },
  subType: { field: 2, type: 'uint32' as const },
  c2cCmd:  { field: 3, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- Message Control ---

export const MessageControlSchema = {
  msgFlag: { field: 1, type: 'int32' as const },
} satisfies ProtoSchema;

// --- RichText (for send — only elems) ---

export const SendRichTextSchema = {
  elems: { field: 2, type: 'repeated_message' as const, schema: ElemSchema },
} satisfies ProtoSchema;

// --- MessageBody (for send) ---

export const SendMessageBodySchema = {
  richText:   { field: 1, type: 'message' as const, schema: SendRichTextSchema },
  // C2C file payload — serialised `FileExtra { file: NotOnlineFile }`
  // bytes. See proton/action.ts:SendMessageBody for the WHY.
  msgContent: { field: 2, type: 'bytes' as const },
} satisfies ProtoSchema;

// --- SendMessageRequest ---

export const SendMessageRequestSchema = {
  routingHead:    { field: 1, type: 'message' as const, schema: RoutingHeadSchema },
  contentHead:    { field: 2, type: 'message' as const, schema: SendContentHeadSchema },
  messageBody:    { field: 3, type: 'message' as const, schema: SendMessageBodySchema },
  clientSequence: { field: 4, type: 'uint32' as const },
  random:         { field: 5, type: 'uint32' as const },
  syncCookie:     { field: 6, type: 'bytes' as const },
  via:            { field: 8, type: 'uint32' as const },
  dataStatist:    { field: 9, type: 'uint32' as const },
  ctrl:           { field: 12, type: 'message' as const, schema: MessageControlSchema },
  multiSendSeq:   { field: 14, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- SendMessageResponse ---

export const SendMessageResponseSchema = {
  result:          { field: 1, type: 'int32' as const },
  errMsg:          { field: 2, type: 'string' as const },
  timestamp1:      { field: 3, type: 'uint32' as const },
  field10:         { field: 10, type: 'uint32' as const },
  groupSequence:   { field: 11, type: 'uint32' as const },
  timestamp2:      { field: 12, type: 'uint32' as const },
  privateSequence: { field: 14, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- MentionExtra (for building @mention text element) ---

export const MentionExtraSendSchema = {
  type:   { field: 3, type: 'int32' as const },
  uin:    { field: 4, type: 'uint32' as const },
  field5: { field: 5, type: 'int32' as const },
  uid:    { field: 9, type: 'string' as const },
} satisfies ProtoSchema;

// --- MarkdownData ---

export const MarkdownDataSchema = {
  content: { field: 1, type: 'string' as const },
} satisfies ProtoSchema;
