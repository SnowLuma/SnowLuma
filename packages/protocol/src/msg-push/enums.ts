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
  /**
   * Self-join admittance — fires on the bot's session right after an
   * admin approves its `set_group_add_request` or an invite-accept
   * goes through. Ported from `lagrange-python`'s
   * `server_push/msg.py:108 case 85`. Maps to OneBot11
   * `notice.group_increase` with the bot itself as `user_id` —
   * existing 33 (GroupMemberIncreaseNotice) doesn't fire for the
   * bot's own join, so without this case the bot never knows it
   * just entered a group until the first message arrives.
   */
  GroupSelfJoinedNotice = 85,
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
  /**
   * Voice-to-text (语音转文字) async result push, fired after a
   * `pttTrans.Trans{C2C,Group}PttReq` once the server finishes transcribing.
   * Live-verified body: `{ f1:uint, f2:{ f1=msgId, f8=text, ... } }`. There's
   * no static sys_msg_0x210_0x3d handler — the ptt-trans subsystem registers
   * it dynamically; we decode it into an internal `ptt_trans_result` event.
   */
  PttTransResult = 61,
  /**
   * Outgoing friend-message recall — bot recalled its own message that
   * was sent to a friend. Same `FriendRecall` wire shape as 138; the
   * difference is direction (138 = friend recalled their own message
   * sent to bot, 139 = bot recalled own message sent to friend).
   * Cross-referenced against Lagrange V2 (`FriendRecallMessageProcessor`
   * registered for both 138 and 139) + acidify (`138, 139 ->
   * parseFriendRecall`). The decoder uses the subType to figure out
   * which UID side ends up as `userUin` on the emitted event.
   */
  FriendRecallSelfNotice = 139,
  FriendRecallNotice = 138,
  FriendPokeNotice = 290,
  /**
   * Mutual-accept friend notice — 179 fires when bot sent a friend
   * request and the other side accepted; 226 fires for the opposite
   * direction. Both decode through the same `NewFriend` wire shape
   * (LagrangeGo registers them via a `case 226: case 179:` fallthrough
   * in `client/listener.go:248-258`). Maps to OneBot11
   * `notice.friend_add`.
   */
  NewFriendNotice = 179,
  NewFriendNoticeAlt = 226,
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
  /**
   * Unmapped QQ-NT-internal subType — first seen as a recurring
   * "Event0x210 unknown subType=380" debug log in production captures.
   *
   * The tsuzcx/qq_apk decompile of the legacy QQ Android client only
   * enumerates SubType0x26 (38) through SubType0x146 (326) under
   * `com.tencent.imcore.message.ext.codec.decoder.msgType0x210/` —
   * `SubType0x17c.java` (380) literally doesn't exist in that tree, so
   * 380 is a QQ-NT-era addition rather than a missed legacy subType.
   *
   * The NT-era reference clients also don't handle it: Lagrange.Core
   * (`PushMessageService.cs`), LagrangeGo (`client/listener.go`),
   * lagrange-python (`server_push/msg.py`), and mania (`push_msg.rs`)
   * each enumerate explicit 0x210 subtypes and none include 380 / 0x17C.
   *
   * Most likely a QQ-NT-client-UI state push (similar to 38) that
   * doesn't map to any OneBot event. Acknowledge silently to keep the
   * unknown log clean; if a real OneBot event ends up depending on it,
   * revisit with whichever NT-era project finally maps the schema.
   */
  UnmappedClientState380 = 380,
}
