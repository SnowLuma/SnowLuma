/** Re-upload metadata carried by received record/video elements. */
export interface MediaNode {
  fileUuid?: string;
  storeId?: number;
  uploadTime?: number;
  ttl?: number;
  subType?: number;
  info?: {
    fileSize?: number;
    fileHash?: string;
    fileSha1?: string;
    fileName?: string;
    width?: number;
    height?: number;
    time?: number;
    original?: number;
    type?: {
      type?: number;
      picFormat?: number;
      videoFormat?: number;
      voiceFormat?: number;
    };
  };
}

export interface TextElement {
  type: 'text';
  text: string;
}

export interface AtElement {
  type: 'at';
  /** 0 denotes @all. */
  targetUin: number;
  uid?: string;
  text?: string;
}

export interface FaceElement {
  type: 'face';
  faceId: number;
}

export interface ReplyElement {
  type: 'reply';
  replySeq: number;
  replyMessageId?: number;
  replySenderUin?: number;
  replyTime?: number;
  replyRandom?: number;
  /** Decoded quoted elements, used to backfill get_msg locally. */
  replyElements?: MessageElement[];
}

export interface JsonElement {
  type: 'json';
  text: string;
}

export interface XmlElement {
  type: 'xml';
  text: string;
  subType?: number;
}

export interface MarkdownElement {
  type: 'markdown';
  text: string;
}

export interface ForwardElement {
  type: 'forward';
  resId: string;
  forwardSource?: string;
  forwardSummary?: string;
  forwardPrompt?: string;
  forwardNews?: Array<{ text: string }>;
  forwardTSum?: number;
  /** Links a nested preview to its piggybacked actionCommand. */
  forwardUuid?: string;
}

interface FingerprintFields {
  md5Hex?: string;
  sha1Hex?: string;
  /** Disallow falling back to source bytes when a fast upload misses. */
  noByteFallback?: boolean;
}

export interface ImageElement extends FingerprintFields {
  type: 'image';
  imageUrl?: string;
  fileId?: string;
  fileName?: string;
  fileSize?: number;
  url?: string;
  subType?: number;
  summary?: string;
  width?: number;
  height?: number;
  flash?: boolean;
  picFormat?: number;
}

export interface RecordElement extends FingerprintFields {
  type: 'record';
  fileName?: string;
  fileId?: string;
  fileSize?: number;
  fileHash?: string;
  url?: string;
  duration?: number;
  voiceFormat?: number;
  mediaNode?: MediaNode;
}

export interface VideoElement extends FingerprintFields {
  type: 'video';
  fileName?: string;
  fileId?: string;
  fileSize?: number;
  fileHash?: string;
  url?: string;
  thumbUrl?: string;
  duration?: number;
  width?: number;
  height?: number;
  videoFormat?: number;
  mediaNode?: MediaNode;
}

/** Market face (商城表情); emojiId is the hex wire face GUID. */
export interface MarketFaceElement {
  type: 'mface';
  emojiId: string;
  emojiPackageId?: number;
  emojiKey?: string;
  text?: string;
}

export interface FileElement {
  type: 'file';
  fileId?: string;
  fileName?: string;
  fileSize?: number;
  fileHash?: string;
  url?: string;
  md5Hex?: string;
  sha1Hex?: string;
}

/** Window-shake element; outbound use is limited to ordinary friend C2C. */
export interface PokeElement {
  type: 'poke';
  subType: number;
}

/** Receive-side flash-transfer card; sending uses send_flash_msg. */
export interface FlashFileElement {
  type: 'flash_file';
  filesetId: string;
  sceneType?: number;
  fileName?: string;
}

type MessageElementVariant =
  | TextElement
  | AtElement
  | FaceElement
  | ReplyElement
  | JsonElement
  | XmlElement
  | MarkdownElement
  | ForwardElement
  | ImageElement
  | RecordElement
  | VideoElement
  | MarketFaceElement
  | FileElement
  | PokeElement
  | FlashFileElement;

type UnionKeys<T> = T extends T ? keyof T : never;
type StrictUnionMember<T, All> = T extends T
  ? T & Partial<Record<Exclude<UnionKeys<All>, keyof T>, never>>
  : never;

/**
 * Closed message-element vocabulary. The optional-never fields make excess
 * fields fail at compile time even when assigning an object to the union
 * directly (for example, `{ type: 'poke', faceId: 1 }` is illegal).
 */
export type MessageElement = StrictUnionMember<MessageElementVariant, MessageElementVariant>;
export type MessageElementType = MessageElementVariant['type'];
export type MessageElementOf<T extends MessageElementType> = Extract<MessageElementVariant, { type: T }>;

export interface ForwardNodePayload {
  userUin: number;
  nickname: string;
  elements: MessageElement[];
  // Optional context preserved when known (download path or upload-via-id),
  // so `get_forward_msg` can emit OneBot11-compatible OB11Message objects.
  time?: number;
  msgId?: number;
  msgSeq?: number;
  groupId?: number;
  senderCard?: string;
  messageType?: 'group' | 'private';
  // When set, this node's `content` is a nested forward chain. The
  // upload pipeline (see `actions/forward.ts::uploadForwardNodes`)
  // recursively uploads the inner chain and replaces this node's
  // `elements` with an ARK preview element pointing at the inner
  // res_id. We also piggyback the inner chain's msgBody onto the
  // outer long-msg upload as an extra `actionCommand` slot so the
  // NapCat-compatible receiver can walk the whole tree from one
  // server fetch without resolving each layer's res_id separately
  // (modelled after `dev/NapCatQQ/.../SendMsg.uploadForwardedNodesPacket`).
  // Caller never sets this on top-level OneBot input — `parseForward
  // Nodes` synthesises it when it detects a nested-node array.
  innerForward?: ForwardNodePayload[];
}

export interface QQEvent {
  time: number;
  selfUin: number;
}

export interface FriendMessage extends QQEvent {
  kind: 'friend_message';
  senderUin: number;
  /** The other participant in this private conversation. Differs from
   *  senderUin for messages sent by the logged-in account. */
  peerUin?: number;
  /** Stable QQ UID carried by ResponseHead. Kept internally so the identity
   *  index can preserve the exact C2C peer instead of re-resolving its UIN. */
  senderUid?: string;
  senderNick: string;
  /** Sender-local sequence exposed as OneBot message_seq and used by replies. */
  msgSeq: number;
  /** Bidirectional C2C sequence used for history/actions and canonical message ids. */
  ntMsgSeq?: number;
  /** Sender-local sequence used by private recall requests. */
  clientSeq?: number;
  /** False only when an older packet omitted ContentHead field 11. */
  sequenceAuthoritative?: boolean;
  msgId: number;
  elements: MessageElement[];
}

export interface GroupMessage extends QQEvent {
  kind: 'group_message';
  groupId: number;
  /** Group display name. From the message's own wire field (ResponseGrp
   *  field 7 — accurate even right after a rename), falling back to the
   *  identity group cache, else '' when neither is available. */
  groupName: string;
  senderUin: number;
  senderNick: string;
  senderCard: string;
  senderRole: string;
  msgSeq: number;
  msgId: number;
  elements: MessageElement[];
}

export interface TempMessage extends QQEvent {
  kind: 'temp_message';
  senderUin: number;
  /** Source group of the temp session (from responseHead.forward), or 0. */
  groupId: number;
  senderNick: string;
  msgSeq: number;
  ntMsgSeq?: number;
  clientSeq?: number;
  sequenceAuthoritative?: boolean;
  elements: MessageElement[];
}

export interface GroupMemberJoin extends QQEvent {
  kind: 'group_member_join';
  groupId: number;
  userUin: number;
  operatorUin: number;
  userUid?: string;
  operatorUid?: string;
  /**
   * Admission mode derived from GroupChange field 4. This is deliberately
   * separate from QQ's nested invitation-source enum, which has different
   * wire semantics. It is absent on the separate self-join push path.
   */
  joinType?: 'approve' | 'invite';
}

export interface GroupMemberLeave extends QQEvent {
  kind: 'group_member_leave';
  groupId: number;
  userUin: number;
  operatorUin: number;
  userUid?: string;
  operatorUid?: string;
  /**
   * Protocol-level reason the member left, derived from
   * GroupChange.decreaseType. `kick` is split into kick / kick_me
   * downstream (OneBot converter) by comparing against selfId.
   */
  leaveType: 'leave' | 'kick' | 'disband';
}

export interface GroupMuteEvent extends QQEvent {
  kind: 'group_mute';
  groupId: number;
  userUin: number;
  operatorUin: number;
  duration: number;
}

export interface GroupAdminEvent extends QQEvent {
  kind: 'group_admin';
  groupId: number;
  userUin: number;
  set: boolean;
}

export interface FriendRecall extends QQEvent {
  kind: 'friend_recall';
  userUin: number;
  /** Legacy alias retained for converters; this is the sender-local sequence. */
  msgSeq: number;
  /** Sender-local sequence carried by the recall protocol. */
  clientSeq?: number;
  /** True for subtype 139, where the logged-in account recalled its own send. */
  recalledBySelf?: boolean;
}

export interface GroupRecallEvent extends QQEvent {
  kind: 'group_recall';
  groupId: number;
  operatorUin: number;
  authorUin: number;
  msgSeq: number;
}

export interface FriendRequestEvent extends QQEvent {
  kind: 'friend_request';
  fromUin: number;
  fromUid?: string;
  message: string;
  flag: string;
}

export interface GroupInviteEvent extends QQEvent {
  kind: 'group_invite';
  groupId: number;
  fromUin: number;
  fromUid?: string;
  subType: string;
  message: string;
  flag: string;
}

export interface FriendPokeEvent extends QQEvent {
  kind: 'friend_poke';
  userUin: number;
  targetUin: number;
  action: string;
  suffix: string;
  actionImgUrl: string;
}

export interface GroupPokeEvent extends QQEvent {
  kind: 'group_poke';
  groupId: number;
  userUin: number;
  targetUin: number;
  action: string;
  suffix: string;
  actionImgUrl: string;
}

export interface GroupEssenceEvent extends QQEvent {
  kind: 'group_essence';
  groupId: number;
  senderUin: number;
  operatorUin: number;
  msgSeq: number;
  random: number;
  set: boolean;
}

export interface GroupFileUploadEvent extends QQEvent {
  kind: 'group_file_upload';
  groupId: number;
  userUin: number;
  fileId: string;
  fileName: string;
  fileSize: number;
  busId: number;
}

export interface FriendAddEvent extends QQEvent {
  kind: 'friend_add';
  userUin: number;
}

export interface GroupMsgEmojiLikeEvent extends QQEvent {
  kind: 'group_msg_emoji_like';
  groupId: number;
  operatorUin: number;
  operatorUid: string;
  /** Sequence of the message that was reacted to (server-assigned msg_seq). */
  msgSeq: number;
  /** Emoji ID. QQ system faces are short numeric strings; market faces
   *  are alphanumeric. We keep the wire string verbatim. */
  emojiId: string;
  /** Multiplicity of the reaction event. Usually 1. */
  count: number;
  /** True when the reaction is being added; false when removed. */
  isAdd: boolean;
}

/**
 * Async voice-to-text result, pushed by the server (Event 0x210 subType 61)
 * after a `pttTrans.Trans{C2C,Group}PttReq`. `msgId` echoes the request's
 * msgId — the correlation key a pending `fetch_ptt_text` waits on. Internal
 * (not surfaced to OneBot clients).
 */
export interface PttTransResultEvent extends QQEvent {
  kind: 'ptt_trans_result';
  msgId: number;
  text: string;
}

/**
 * The bot account was forced offline (kicked / logged in elsewhere / risk-control)
 * — SSO push `StatusService.KickNT`. Mirrors NapCat's OB11BotOfflineEvent →
 * `notice_type:'bot_offline'`. `tag` = short title, `message` = description.
 */
export interface BotOfflineEvent extends QQEvent {
  kind: 'bot_offline';
  tag: string;
  message: string;
}

/**
 * A group member's card (群名片) changed — detected from message traffic when
 * the sender's live card differs from the cached one (same mechanism as NapCat's
 * `parseCardChangedEvent`). Maps to OB11 `notice_type:'group_card'`.
 */
export interface GroupCardChangeEvent extends QQEvent {
  kind: 'group_card_change';
  groupId: number;
  userUin: number;
  cardNew: string;
  cardOld: string;
}

/**
 * A group member was granted a special title (群头衔) — Event 0x2DC subType 16,
 * field13 == 6. Maps to OB11 `notice/notify` `sub_type:'title'`.
 */
export interface GroupTitleChangeEvent extends QQEvent {
  kind: 'group_title_change';
  groupId: number;
  userUin: number; // the member who received the title
  title: string;
}

/**
 * Group name changed (Event 0x2DC subType 16, field13 == 12). Mirrors NapCat's
 * OB11GroupNameEvent → `notice/notify` `sub_type:'group_name'`.
 */
export interface GroupNameChangeEvent extends QQEvent {
  kind: 'group_name_change';
  groupId: number;
  operatorUin: number; // who renamed the group
  name: string;        // the new group name
}

/**
 * Someone liked the bot's profile card ("名片赞") — Event 0x210 subType 39,
 * inner ProfileLikeTip msgType 0 / subType 203. Mirrors NapCat's
 * OB11ProfileLikeEvent → `notice/notify` `sub_type:'profile_like'`.
 */
export interface FriendProfileLikeEvent extends QQEvent {
  kind: 'friend_profile_like';
  operatorUin: number;   // who liked
  operatorNick: string;
  times: number;         // like count from this event
}

/**
 * C2C "对方正在输入…" input-status push (Event 0x210 subType 0x115 / 277).
 * `eventType` 1 = typing, 3 = recording a voice message. Mirrors NapCat's
 * `onInputStatusPush` → OB11 `notice/notify` `sub_type:'input_status'`.
 */
export interface FriendInputStatusEvent extends QQEvent {
  kind: 'friend_input_status';
  userUin: number;   // the peer whose input status changed (the typer)
  userUid: string;
  eventType: number; // 1 = 正在输入, 3 = 正在讲话(录音)
  statusText: string;
}

export type OnlineDeviceKind = 'computer' | 'pad' | 'phone' | 'unknown';

/** One entry from QQ NT's online-device cache notification. */
export interface OnlineDeviceInfo {
  appId: number;
  instanceId: number;
  clientType: number;
  platform: number;
  deviceName: string;
  deviceKind: OnlineDeviceKind;
}

/**
 * Full online-device snapshot pushed through Event 0x210 / subType 349.
 * Internal-only: Bridge consumes this to maintain the query snapshot; it is
 * not forwarded as an OneBot event.
 */
export interface OnlineDevicesChangedEvent extends QQEvent {
  kind: 'online_devices_changed';
  devices: OnlineDeviceInfo[];
}

export type QQEventVariant =
  | FriendMessage
  | GroupMessage
  | TempMessage
  | GroupMemberJoin
  | GroupMemberLeave
  | GroupMuteEvent
  | GroupAdminEvent
  | FriendRecall
  | GroupRecallEvent
  | FriendRequestEvent
  | GroupInviteEvent
  | FriendPokeEvent
  | GroupPokeEvent
  | GroupEssenceEvent
  | GroupFileUploadEvent
  | FriendAddEvent
  | GroupMsgEmojiLikeEvent
  | PttTransResultEvent
  | FriendInputStatusEvent
  | GroupNameChangeEvent
  | GroupCardChangeEvent
  | GroupTitleChangeEvent
  | FriendProfileLikeEvent
  | OnlineDevicesChangedEvent
  | BotOfflineEvent;
