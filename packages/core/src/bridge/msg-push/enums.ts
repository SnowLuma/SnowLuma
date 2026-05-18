// MsgPush PkgType taxonomy. The top-level msgType field in PushMsg.contentHead
// names a QQ-protocol-defined packet shape; Event0x210 / Event0x2DC are wrapper
// PkgTypes whose payload is further dispatched by subType.

export enum PkgType {
  ForwardFakePrivateMessage = 9,
  PrivateMessage = 166,
  GroupMessage = 82,
  TempMessage = 141,
  Event0x210 = 528,
  Event0x2DC = 732,
  PrivateRecordMessage = 208,
  PrivateFileMessage = 529,
  GroupRequestInvitationNotice = 525,
  GroupRequestJoinNotice = 84,
  GroupInviteNotice = 87,
  GroupAdminChangedNotice = 44,
  GroupMemberIncreaseNotice = 33,
  GroupMemberDecreaseNotice = 34,
}

export enum Event0x2DCSubType {
  GroupMuteNotice = 12,
  GroupMsgEmojiLikeNotice = 16,
  GroupRecallNotice = 17,
  GroupGreyTipNotice = 20,
  GroupEssenceNotice = 21,
}

export enum Event0x210SubType {
  FriendRequestNotice = 35,
  FriendRecallNotice = 138,
  FriendPokeNotice = 290,
}
