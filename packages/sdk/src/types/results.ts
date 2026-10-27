import type { JsonArray, JsonObject, JsonValue } from './json.js';

export interface QzoneCommentReply {
    uin: number;
    name: string;
    /** Unix seconds. */
    time: number;
    content: string;
    /** Scoped to the post, or parent comment for replies. */
    comment_id: string;
    /** Present on nested replies from newer servers; identifies their top-level parent. */
    parent_comment_id?: string;
    parent_comment_uin?: number;
}

export interface QzoneComment extends QzoneCommentReply {
    /** Inline replies only; Qzone may omit further replies. */
    replies: QzoneCommentReply[];
}

export interface QzoneMsgDetailResult {
    tid: string;
    content: string;
    /** Server-reported total, not the number of comments on this page. */
    comment_num: number;
    comments: QzoneComment[];
}

export interface SendMessageResult {
    message_id: number;
}

export interface ForwardMessageResult {
    message_id: number;
    res_id: string;
    forward_id: string;
}

export interface UploadForwardResult {
    message_id: number;
    res_id: string;
    forward_id: string;
    group_id?: number;
}

export interface LoginInfo {
    user_id: number;
    nickname: string;
}

export interface StatusInfo {
    online: boolean;
    good: boolean;
    /** Current account-session uptime in seconds, matching #sl. */
    time: number;
}

export interface VersionInfo {
    app_name: string;
    app_version: string;
    protocol_version: string;
}

export interface CapabilityInfo {
    yes: boolean;
}

export interface GroupFileUrl {
    url: string;
}

export interface PrivateFileUrl {
    url: string;
}

export interface GroupFileSystemInfo {
    file_count: number;
    limit_count: number;
    used_space: number;
    total_space: number;
}

export interface GroupMessageHistory {
    messages: JsonObject[];
}

export interface FriendMessageHistory {
    messages: JsonObject[];
}

export interface GroupNoticeInfo {
    notice_id: string;
    sender_id: number;
    publish_time: number;
    message: {
        text: string;
        image: Array<{ id: string; url: string; height: number; width: number }>;
        images: Array<{ id: string; url: string; height: number; width: number }>;
    };
    settings: JsonValue;
    read_num: number;
    /** Server response type; regular announcements are commonly returned as 6. */
    type: number;
    pinned: number;
    send_to_new_members: boolean;
}

export interface CategorizedFriend {
    user_id: number;
    nickname: string;
    remark: string;
}

export interface FriendCategoryResult {
    categoryId: number;
    categoryName: string;
    categoryMbCount: number;
    buddyList: CategorizedFriend[];
}

export interface MediaInfo extends JsonObject {}

export interface CookieInfo {
    cookies: string;
}

export interface CsrfInfo {
    token: number;
}

export interface CredentialsInfo {
    cookies: string;
    token: number;
    csrf_token: number;
}

export interface DownloadFileResult {
    file: string;
}

export interface ClientKeyInfo {
    clientKey: string;
    keyIndex: string;
    expireTime: string;
}

export interface OnlineClientInfo {
    app_id: number;
    device_name: string;
    device_kind: '电脑' | 'Pad' | '手机' | '未知设备';
}

export interface OnlineClientsInfo {
    clients: OnlineClientInfo[];
}

export interface CollectionAuthorInfo extends JsonObject {
    type: number;
    numId: string;
    strId: string;
    groupId: string;
    groupName: string;
    uid: string;
}

export interface CollectionSummaryInfo extends JsonObject {
    textSummary: JsonValue;
    linkSummary: JsonValue;
    gallerySummary: JsonValue;
    audioSummary: JsonValue;
    videoSummary: JsonValue;
    fileSummary: JsonValue;
    locationSummary: JsonValue;
    richMediaSummary: JsonValue;
}

export interface CollectionItemInfo extends JsonObject {
    cid: string;
    type: number;
    status: number;
    author: CollectionAuthorInfo;
    bid: number;
    category: number;
    createTime: string;
    collectTime: string;
    modifyTime: string;
    sequence: string;
    shareUrl: string;
    customGroupId: number;
    securityBeat: boolean;
    summary: CollectionSummaryInfo;
}

export interface CollectionSearchListInfo extends JsonObject {
    collectionItemList: CollectionItemInfo[];
    hasMore: boolean;
    bottomTimeStamp: string;
}

export interface CollectionListInfo extends JsonObject {
    errCode: number;
    errMsg: string;
    collectionSearchList: CollectionSearchListInfo;
}

export interface SystemFaceInfo extends JsonObject {
    q_sid: string;
    q_des: string;
    em_code: string;
    q_cid: number | null;
    ani_sticker_type: number | null;
    ani_sticker_pack_id: number | null;
    ani_sticker_id: number | null;
    url: string | null;
    emoji_name_alias: string[];
    ani_sticker_width: number | null;
    ani_sticker_height: number | null;
    is_super: boolean;
}

export interface SystemFacePackInfo extends JsonObject {
    pack_name: string;
    emojis: SystemFaceInfo[];
}

export interface SystemFaceCatalogInfo extends JsonObject {
    packs: SystemFacePackInfo[];
}

export interface SystemFaceSearchInfo extends JsonObject {
    faces: SystemFaceInfo[];
}

export interface SuperFaceInfo extends JsonObject {
    is_super: boolean;
}

export interface UrlSafetyInfo {
    level: number;
}

export interface GroupAtAllRemainInfo {
    can_at_all: boolean;
    remain_at_all_count_for_group: number;
    remain_at_all_count_for_uin: number;
}

export interface GroupCategoryTag {
    id: number;
    name: string;
    type: number;
}

export interface GroupCategoryTagList {
    tags: GroupCategoryTag[];
}

export type GroupAdminSettings = {
    add_type: number;
    group_question: string;
    group_answer: string;
    robot_member_switch: number;
    robot_member_examine: number;
    member_invite_policy: 'disabled' | 'require_approval' | 'no_approval' | 'no_approval_under_100';
    allow_member_upload_album: boolean;
    allow_member_temporary_session: boolean;
    allow_member_create_group: boolean;
    new_member_history_visible: boolean;
    no_finger_open: number;
    no_code_finger_open: number;
};

export interface GroupAdminPermissions {
    group_id: number;
    user_id: number;
    /** Null means the server did not specify this permission. */
    recall_member_message: boolean | null;
    kick_member: boolean | null;
    /** Zero means unlimited; null means removal is disabled or unspecified. */
    kick_member_per_day: number | null;
    /** Whether join-verification messages are received; null means the state was not returned. */
    receive_verify: boolean | null;
}

export interface GroupTodoListItem {
    message_id: number;
    message_seq: number;
    message_random: number;
    message: JsonArray | null;
    text: string;
    create_time: number;
    update_time: number;
}

export type EmptyData = null;

// — AI 语音角色：get_ai_characters 返回的分类数组 —
export interface AiCharacter {
    character_id: string;
    character_name: string;
    preview_url: string;
}

export interface AiCharacterCategory {
    type: string;
    characters: AiCharacter[];
}

// — nc_get_user_status 返回的状态字 —
export interface UserOnlineStatus {
    status: number;
    ext_status: number;
}

// — send_group_ai_record 返回 —
export interface SendGroupAiRecordResult {
    message_id: number;
}

export interface CustomFaceDetail extends JsonObject {
    emoji_id: string;
    resId: string;
    url: string;
    md5: string;
    desc: string;
}

export interface AddCustomFaceResult extends JsonObject {
    emoji_id: string;
}

export interface PttTextResult extends JsonObject {
    text: string;
}

export interface MessageEmojiLikeInfo extends JsonObject {
    emoji_id: string;
    emoji_type: number;
    count: number;
    last_reaction_time: number;
    users: Array<{ user_id: number }>;
}

export interface GroupSignedMember extends JsonObject {
    user_id: number;
    nick: string;
    time: number;
    rank: number;
}

export interface DoubtFriendsAddRequest extends JsonObject {
    /** Pass this UID back as the request's flag. */
    uid: string;
    user_id: number;
    nick: string;
    source: string;
    reason: string;
    msg: string;
    group_code: string;
    reqTime: number;
}

export interface FriendDressItem extends JsonObject {
    app_id: number;
    kind: string;
    item_id: number;
    name: string;
    preview_url: string;
    video_url: string;
    price: number;
}

export interface FriendDressResult extends JsonObject {
    target_uin: string;
    is_svip: boolean;
    avatar_url: string;
    items: FriendDressItem[];
}

export interface ArkShareResult extends JsonObject {
    arkMsg: string;
}

export interface DecryptKeyResult extends JsonObject {
    db_key: string;
}

export interface RkeyServerResult extends JsonObject {
    /** Unix seconds; either key can be absent. */
    expired_time: number;
    name: string;
    private_rkey?: string;
    group_rkey?: string;
}

export interface QzoneEmotion extends JsonObject {
    tid: string;
    content: string;
    /** Unix seconds. */
    time: number;
    comment_num: number;
    is_private: boolean;
    images: string[];
}

export interface QzoneMsgListResult extends JsonObject {
    total: number;
    msglist: QzoneEmotion[];
}

export interface QzoneProfileResult extends JsonObject {
    name: string;
    description: string;
}

export interface QzonePublicFeedsPage extends JsonObject {
    /** Original feed cells, with the upstream item.feed wrapper removed. */
    feeds: JsonObject[];
    /** Controls pagination even when a page contains fewer than ten items. */
    has_more: boolean;
    /** Account-bound continuation; null when the list ends. */
    next_cursor: string | null;
}

export interface QzoneFeed extends JsonObject {
    uin: number;
    nickname: string;
    time: number;
    appid: number;
    key: string;
    html: string;
    /** Newer servers return these fields; null means the source could not establish the value. */
    tid?: string | null;
    content?: string | null;
    /** False for a collapsed excerpt; null when content is unavailable. */
    content_complete?: boolean | null;
    /** Images visible in the post body, excluding avatars, comment images and video covers. */
    images?: string[] | null;
    like_count?: number | null;
    comment_count?: number | null;
}

export interface QzoneFeedsResult extends JsonObject {
    feeds: QzoneFeed[];
    has_more: boolean;
    /** Opaque account-bound continuation; null at the end, absent on older servers. */
    next_cursor?: string | null;
}

export interface QzonePublishResult extends JsonObject {
    tid: string;
    time: number;
}

export interface QzoneCommentResult extends JsonObject {
    /** New comment/reply ID. Ordinary comments may return an empty string if upstream omits it. */
    comment_id: string;
    /** Present when creating a nested reply, distinct from its new comment_id. */
    parent_comment_id?: string;
    parent_comment_uin?: number;
}

export interface QzoneUpdateRightResult extends JsonObject {
    ugc_right: number;
}

export interface QunAlbumCoverUrl extends JsonObject {
    url: string;
    width: number;
    height: number;
}

export interface QunAlbumCoverPhotoUrl extends JsonObject {
    spec: number;
    url: QunAlbumCoverUrl | null;
}

export interface QunAlbumCoverImage extends JsonObject {
    name: string;
    sloc: string;
    lloc: string;
    photoUrls: QunAlbumCoverPhotoUrl[];
    defaultUrl: QunAlbumCoverUrl | null;
    isGif: boolean;
    hasRaw: boolean;
}

export interface QunAlbumCover extends JsonObject {
    type: number;
    image: QunAlbumCoverImage | null;
}

export interface GroupAlbumInfo extends JsonObject {
    id: string;
    name: string;
    picNum: number;
    createTime: number;
    desc: string;
    owner: string;
    createuin: string;
    createnickname: string;
    last_upload_time: number;
    cover: QunAlbumCover | null;
}

export interface QunAlbumCreator extends JsonObject {
    uid: string;
    nick: string;
    is_sweet: boolean;
    is_special: boolean;
    is_super_like: boolean;
    custom_id: string;
    poly_id: string;
    portrait: string;
    can_follow: number;
    isfollowed: number;
    uin: string;
    ditto_uin: string;
}

export interface QunAlbumInfo extends JsonObject {
    album_id: string;
    owner: string;
    name: string;
    desc: string;
    /** The Qun API preserves 64-bit times and counts as decimal strings. */
    create_time: string;
    modify_time: string;
    last_upload_time: string;
    upload_number: string;
    cover: QunAlbumCover | null;
    creator?: QunAlbumCreator;
    top_flag: string;
    busi_type: number;
    status: number;
    allow_share: boolean;
    is_subscribe: boolean;
    bitmap: string;
    is_share_album: boolean;
    qz_album_type: number;
    cover_type: number;
    default_desc: string;
    sort_type: number;
}

export interface QunAlbumListResult extends JsonObject {
    album_list: QunAlbumInfo[];
    attach_info: string;
    has_more: boolean;
}

// Media-list fields are passed through from QQ, unlike normalized album covers.
// Omitted fields stay optional; explicitly undefined decoded values become null.
export interface GroupAlbumMediaUrl extends JsonObject {
    url?: string | null;
    width?: number | null;
    height?: number | null;
}

export interface GroupAlbumMediaPhotoUrl extends JsonObject {
    spec?: number | null;
    url?: GroupAlbumMediaUrl | null;
}

export interface GroupAlbumMediaImage extends JsonObject {
    name?: string | null;
    sloc?: string | null;
    lloc?: string | null;
    photoUrls?: GroupAlbumMediaPhotoUrl[] | null;
    defaultUrl?: GroupAlbumMediaUrl | null;
    isGif?: boolean | null;
    hasRaw?: boolean | null;
}

export interface GroupAlbumMediaVideo extends JsonObject {
    id?: string | null;
    url?: string | null;
    cover?: GroupAlbumMediaImage | null;
    width?: number | null;
    height?: number | null;
    videoTime?: string | null;
    videoUrl?: GroupAlbumMediaPhotoUrl[] | null;
}

export interface GroupAlbumMediaInfo extends JsonObject {
    type?: number | null;
    image?: GroupAlbumMediaImage | null;
    video?: GroupAlbumMediaVideo | null;
    uploader?: string | null;
    batchId?: string | null;
    uploadTime?: string | null;
}

export interface GroupAlbumMediaResult extends JsonObject {
    mediaList: GroupAlbumMediaInfo[];
    nextAttachInfo: string;
}

export interface GroupAlbumCommentResult extends JsonObject {
    id: string;
    user: { uin: string };
    content: Array<{ type: number; content: string }>;
    time: string;
    clientKey: string;
}

export interface GroupAlbumMediaLikeResult extends JsonObject {
    id?: string | null;
    status?: number | null;
}

export interface UploadGroupAlbumVideoResult extends JsonObject {
    id: string;
}

export interface DeleteGroupAlbumMediaResult extends JsonObject {
    success: true;
}

export interface CreateFlashTaskResult extends JsonObject {
    fileset_id: string;
    task_id: string;
}

export interface FlashFileInfo extends JsonObject {
    fileset_id: string;
    file_name: string;
    orig_name: string;
    size: number;
    share_url: string;
    file_id: string;
    download_url: string;
}

export interface FilesetInfo extends JsonObject {
    fileset_id: string;
    file_list: FlashFileInfo[];
}

export interface FlashFileUrl extends JsonObject {
    url: string;
}

export interface DownloadFilesetResult extends FlashFileUrl {
    file_name: string;
    file_size: number;
}

export interface FilesetIdResult extends JsonObject {
    fileset_id: string;
}

export interface SendFlashMsgResult extends JsonObject {
    /** Flash sharing has no ordinary message ID; the server returns this sentinel. */
    message_id: 0;
}

export interface CleanStreamTempFileResult extends JsonObject {
    message: string;
    removed: number;
    freed_bytes: number;
    skipped_active: number;
}

/** Stream errors are carried by failed envelopes; raw() throws for these. */
export interface StreamErrorData extends JsonObject {
    type: 'error';
    data_type: 'error';
}

export interface UploadFileStreamStatus extends JsonObject {
    type: 'stream';
    stream_id: string;
    status: 'file_created' | 'chunk_received';
    received_chunks: number;
    total_chunks: number;
}

export interface UploadFileStreamComplete extends JsonObject {
    type: 'response';
    stream_id: string;
    status: 'file_complete';
    received_chunks: number;
    total_chunks: number;
    file_path: string;
    file_name: string;
    file_size: number;
    sha256: string;
}

export type UploadFileStreamResult =
    UploadFileStreamStatus | UploadFileStreamComplete | StreamErrorData;

export interface DownloadFileStreamInfo extends JsonObject {
    type: 'stream';
    data_type: 'file_info';
    file_name: string;
    file_size: number;
    chunk_size: number;
}

export interface DownloadFileStreamChunk extends JsonObject {
    type: 'stream';
    data_type: 'file_chunk';
    index: number;
    /** Base64-encoded bytes. */
    data: string;
    size: number;
    progress: number;
    base64_size: number;
}

export interface DownloadFileStreamComplete extends JsonObject {
    type: 'response';
    data_type: 'file_complete';
    file_name: string;
    total_chunks: number;
    total_bytes: number;
    message: string;
}

/** One frame's data, not an aggregated download. A streaming transport is required. */
export type DownloadFileStreamResult =
    DownloadFileStreamInfo | DownloadFileStreamChunk | DownloadFileStreamComplete | StreamErrorData;

export type TestDownloadStreamResult =
    | { type: 'stream'; data_type: 'data_chunk'; data: string }
    | { type: 'response'; data_type: 'data_complete'; data: string }
    | StreamErrorData;
