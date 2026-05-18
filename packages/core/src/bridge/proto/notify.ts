// Proto schemas for notification types.
// Port of src/bridge/include/bridge/proto/notify.h

import type { ProtoSchema } from '../../protobuf/decode';

export const OperatorField1Schema = {
  uid:    { field: 1, type: 'string' as const },
  field2: { field: 2, type: 'uint32' as const },
  field3: { field: 3, type: 'bytes' as const },
  field4: { field: 4, type: 'uint32' as const },
  field5: { field: 5, type: 'bytes' as const },
} satisfies ProtoSchema;

export const OperatorInfoSchema = {
  operatorField: { field: 1, type: 'message' as const, schema: OperatorField1Schema },
} satisfies ProtoSchema;

export const GroupChangeSchema = {
  groupUin:       { field: 1, type: 'uint32' as const },
  flag:           { field: 2, type: 'uint32' as const },
  memberUid:      { field: 3, type: 'string' as const },
  decreaseType:   { field: 4, type: 'uint32' as const },
  operatorBytes:  { field: 5, type: 'bytes' as const },
  increaseType:   { field: 6, type: 'uint32' as const },
  field7:         { field: 7, type: 'bytes' as const },
} satisfies ProtoSchema;

export const GroupAdminExtraSchema = {
  adminUid:   { field: 1, type: 'string' as const },
  isPromote:  { field: 2, type: 'bool' as const },
} satisfies ProtoSchema;

export const GroupAdminBodySchema = {
  extraDisable: { field: 1, type: 'message' as const, schema: GroupAdminExtraSchema },
  extraEnable:  { field: 2, type: 'message' as const, schema: GroupAdminExtraSchema },
} satisfies ProtoSchema;

export const GroupAdminSchema = {
  groupUin:   { field: 1, type: 'uint32' as const },
  flag:       { field: 2, type: 'uint32' as const },
  isPromote:  { field: 3, type: 'bool' as const },
  body:       { field: 4, type: 'message' as const, schema: GroupAdminBodySchema },
} satisfies ProtoSchema;

export const InvitationInnerSchema = {
  groupUin:   { field: 1, type: 'uint32' as const },
  field2:     { field: 2, type: 'uint32' as const },
  field3:     { field: 3, type: 'uint32' as const },
  field4:     { field: 4, type: 'uint32' as const },
  targetUid:  { field: 5, type: 'string' as const },
  invitorUid: { field: 6, type: 'string' as const },
  field7:     { field: 7, type: 'uint32' as const },
  field9:     { field: 9, type: 'uint32' as const },
  field10:    { field: 10, type: 'bytes' as const },
  field11:    { field: 11, type: 'uint32' as const },
  field12:    { field: 12, type: 'string' as const },
} satisfies ProtoSchema;

export const InvitationInfoSchema = {
  inner: { field: 1, type: 'message' as const, schema: InvitationInnerSchema },
} satisfies ProtoSchema;

export const GroupInvitationSchema = {
  cmd:  { field: 1, type: 'int32' as const },
  info: { field: 2, type: 'message' as const, schema: InvitationInfoSchema },
} satisfies ProtoSchema;

export const GroupInviteSchema = {
  groupUin:   { field: 1, type: 'uint32' as const },
  field2:     { field: 2, type: 'uint32' as const },
  field3:     { field: 3, type: 'uint32' as const },
  field4:     { field: 4, type: 'uint32' as const },
  invitorUid: { field: 5, type: 'string' as const },
  hashes:     { field: 6, type: 'bytes' as const },
} satisfies ProtoSchema;

export const GroupJoinSchema = {
  groupUin:   { field: 1, type: 'uint32' as const },
  field2:     { field: 2, type: 'uint32' as const },
  targetUid:  { field: 3, type: 'string' as const },
  field4:     { field: 4, type: 'uint32' as const },
  field6:     { field: 6, type: 'uint32' as const },
  field7:     { field: 7, type: 'string' as const },
  field8:     { field: 8, type: 'uint32' as const },
  field9:     { field: 9, type: 'bytes' as const },
} satisfies ProtoSchema;

export const FriendRequestInfoSchema = {
  targetUid:  { field: 1, type: 'string' as const },
  sourceUid:  { field: 2, type: 'string' as const },
  newSource:  { field: 5, type: 'string' as const },
  message:    { field: 10, type: 'string' as const },
  source:     { field: 11, type: 'string' as const },
} satisfies ProtoSchema;

export const FriendRequestSchema = {
  info: { field: 1, type: 'message' as const, schema: FriendRequestInfoSchema },
} satisfies ProtoSchema;

export const FriendRecallTipInfoSchema = {
  tip: { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const FriendRecallInfoSchema = {
  fromUid:          { field: 1, type: 'string' as const },
  toUid:            { field: 2, type: 'string' as const },
  clientSequence:   { field: 3, type: 'uint32' as const },
  newId:            { field: 4, type: 'uint64' as const },
  time:             { field: 5, type: 'uint32' as const },
  random:           { field: 6, type: 'uint32' as const },
  pkgNum:           { field: 7, type: 'uint32' as const },
  pkgIndex:         { field: 8, type: 'uint32' as const },
  divSeq:           { field: 9, type: 'uint32' as const },
  tipInfo:          { field: 13, type: 'message' as const, schema: FriendRecallTipInfoSchema },
} satisfies ProtoSchema;

export const FriendRecallSchema = {
  info:             { field: 1, type: 'message' as const, schema: FriendRecallInfoSchema },
  instId:           { field: 2, type: 'uint32' as const },
  appId:            { field: 3, type: 'uint32' as const },
  longMessageFlag:  { field: 4, type: 'uint32' as const },
  reserved:         { field: 5, type: 'bytes' as const },
} satisfies ProtoSchema;

export const GroupMuteStateSchema = {
  targetUid:  { field: 1, type: 'string' as const },
  duration:   { field: 2, type: 'uint32' as const },
} satisfies ProtoSchema;

export const GroupMuteDataSchema = {
  timestamp:  { field: 1, type: 'uint32' as const },
  type:       { field: 2, type: 'uint32' as const },
  state:      { field: 3, type: 'message' as const, schema: GroupMuteStateSchema },
} satisfies ProtoSchema;

export const GroupMuteSchema = {
  groupUin:     { field: 1, type: 'uint32' as const },
  subType:      { field: 2, type: 'uint32' as const },
  field3:       { field: 3, type: 'uint32' as const },
  operatorUid:  { field: 4, type: 'string' as const },
  data:         { field: 5, type: 'message' as const, schema: GroupMuteDataSchema },
} satisfies ProtoSchema;

export const RecallMessageSchema = {
  sequence:   { field: 1, type: 'uint32' as const },
  time:       { field: 2, type: 'uint32' as const },
  random:     { field: 3, type: 'uint32' as const },
  type:       { field: 4, type: 'uint32' as const },
  flag:       { field: 5, type: 'uint32' as const },
  authorUid:  { field: 6, type: 'string' as const },
} satisfies ProtoSchema;

export const GroupRecallTipInfoSchema = {
  tip: { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const GroupRecallSchema = {
  operatorUid:    { field: 1, type: 'string' as const },
  recallMessages: { field: 3, type: 'repeated_message' as const, schema: RecallMessageSchema },
  userDef:        { field: 5, type: 'bytes' as const },
  groupType:      { field: 6, type: 'int32' as const },
  opType:         { field: 7, type: 'int32' as const },
  tipInfo:        { field: 9, type: 'message' as const, schema: GroupRecallTipInfoSchema },
} satisfies ProtoSchema;

export const TemplParamSchema = {
  name:   { field: 1, type: 'string' as const },
  value:  { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const GeneralGrayTipInfoSchema = {
  busiType:       { field: 1, type: 'uint64' as const },
  busiId:         { field: 2, type: 'uint64' as const },
  ctrlFlag:       { field: 3, type: 'uint32' as const },
  c2cType:        { field: 4, type: 'uint32' as const },
  serviceType:    { field: 5, type: 'uint32' as const },
  templId:        { field: 6, type: 'uint64' as const },
  msgTemplParam:  { field: 7, type: 'repeated_message' as const, schema: TemplParamSchema },
  content:        { field: 8, type: 'string' as const },
} satisfies ProtoSchema;

export const EssenceMessageSchema = {
  groupUin:           { field: 1, type: 'uint32' as const },
  msgSequence:        { field: 2, type: 'uint32' as const },
  random:             { field: 3, type: 'uint32' as const },
  setFlag:            { field: 4, type: 'uint32' as const },
  memberUin:          { field: 5, type: 'uint32' as const },
  operatorUin:        { field: 6, type: 'uint32' as const },
  timestamp:          { field: 7, type: 'uint32' as const },
  msgSequence2:       { field: 8, type: 'uint32' as const },
  operatorNickname:   { field: 9, type: 'string' as const },
  memberNickname:     { field: 10, type: 'string' as const },
  setFlag2:           { field: 11, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NotifyMessageBodySchema = {
  type:             { field: 1, type: 'uint32' as const },
  groupUin:         { field: 4, type: 'uint32' as const },
  eventParam:       { field: 5, type: 'bytes' as const },
  recall:           { field: 11, type: 'message' as const, schema: GroupRecallSchema },
  field13:          { field: 13, type: 'uint32' as const },
  operatorUid:      { field: 21, type: 'string' as const },
  generalGrayTip:   { field: 26, type: 'message' as const, schema: GeneralGrayTipInfoSchema },
  essenceMessage:   { field: 33, type: 'message' as const, schema: EssenceMessageSchema },
  msgSequence:      { field: 37, type: 'uint32' as const },
  field39:          { field: 39, type: 'uint32' as const },
} satisfies ProtoSchema;

// ─── Event0x2DC subType=16: GroupMsgEmojiLike ──────────────────────────────
//
// QQ pushes a Group message emoji reaction (someone tapped an emoji on a
// message in a group). The payload nesting matches NapCat's transformer
// (packet/transformer/proto/message/message.ts → GroupReactNotify); the
// outermost message is preceded by a 7-byte prefix that must be stripped
// before decoding (see the call site).

export const GroupReactionDataInnerDataTargetSchema = {
  seq: { field: 1, type: 'uint64' as const },
} satisfies ProtoSchema;

export const GroupReactionDataContentSchema = {
  code:        { field: 1, type: 'string' as const },
  count:       { field: 3, type: 'uint32' as const },
  operatorUid: { field: 4, type: 'string' as const },
  type:        { field: 5, type: 'uint32' as const },
} satisfies ProtoSchema;

export const GroupReactionDataInnerDataSchema = {
  groupReactionTarget:      { field: 2, type: 'message' as const, schema: GroupReactionDataInnerDataTargetSchema },
  groupReactionDataContent: { field: 3, type: 'message' as const, schema: GroupReactionDataContentSchema },
} satisfies ProtoSchema;

export const GroupReactionDataInnerSchema = {
  data: { field: 1, type: 'message' as const, schema: GroupReactionDataInnerDataSchema },
} satisfies ProtoSchema;

export const GroupReactionDataSchema = {
  data: { field: 1, type: 'message' as const, schema: GroupReactionDataInnerSchema },
} satisfies ProtoSchema;

export const GroupReactNotifySchema = {
  groupUin:          { field: 4, type: 'uint64' as const },
  field13:           { field: 13, type: 'uint32' as const },
  groupReactionData: { field: 44, type: 'message' as const, schema: GroupReactionDataSchema },
} satisfies ProtoSchema;
