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
  /**
   * Group-app state push (troop shortcut bar / discussion app).
   *
   * Sourced from the decompiled stock QQ Android client decoder at
   * `com.tencent.imcore.message.ext.codec.decoder.msgType0x210.SubType0x26`
   * (tsuzcx/qq_apk @ afe46ef). The payload is `submsgtype0x26.MsgBody`
   * dispatching on `uint32_sub_cmd`:
   *
   *   - 0x1 → `UpdateAppUnreadNum`: a list of
   *     `{group_code, app_id, unread_num}` entries the QQ client uses
   *     to keep group-internal "mini-app" badges (e.g. `appId=101846662`
   *     / `101896870` for the shortcut bar) in sync.
   *   - 0x3 → `UpdateDiscussAppInfo`: `{conf_uin, app_tip_notify.text}`
   *     for discussion-group app tips, routed to `getGAudioHandler()`.
   *   - 0x4 → delegated to the troop online-push handler.
   *
   * None of these have a OneBot event mapping — they're QQ-client-UI
   * state pushes (unread badges, in-app tips), not user-visible
   * conversation events. Acknowledge the subType so it doesn't keep
   * showing up as "unknown" in debug logs and drop it silently.
   * Lagrange V2 / lagrange-python / LagrangeGo / acidify all also
   * fall through on this one because they don't surface the shortcut
   * bar either.
   */
  GroupAppStatePush = 38,
}
