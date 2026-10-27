import type { JsonObject, JsonValue } from './json.js';

export interface SendMsgParams extends JsonObject {
    message_type?: 'private' | 'group' | string;
    user_id?: number;
    group_id?: number;
    message: JsonValue;
    auto_escape?: boolean;
}

export interface SendPrivateMsgParams extends JsonObject {
    user_id: number;
    message: JsonValue;
    auto_escape?: boolean;
}

export interface SendGroupMsgParams extends JsonObject {
    group_id: number;
    message: JsonValue;
    auto_escape?: boolean;
}

export interface MessageIdParams extends JsonObject {
    message_id: number;
}

export interface GroupIdParams extends JsonObject {
    group_id: number;
}

export interface GroupClassParams extends JsonObject {
    group_class: number;
}

export interface GroupCategoryTagNameParams extends GroupClassParams {
    name: string;
}

export interface UserIdParams extends JsonObject {
    user_id: number;
}

export interface NoCacheParams extends JsonObject {
    no_cache?: boolean;
}

export interface GetOnlineClientsParams extends NoCacheParams {}

export interface GetGroupListParams extends NoCacheParams {}

export interface GetGroupInfoParams extends GroupIdParams {
    no_cache?: boolean;
}

export interface GetGroupShareLinkParams extends GroupIdParams {
    need_short_url?: boolean;
    src_id?: number;
    additional_param?: string;
}

export interface GetGroupMemberListParams extends GroupIdParams {
    no_cache?: boolean;
}

export interface GetGroupMemberInfoParams extends GroupIdParams {
    user_id: number;
    no_cache?: boolean;
}

export interface GetGroupHonorInfoParams extends GroupIdParams {
    type?: 'talkative' | 'performer' | 'legend' | 'strong_newbie' | 'emotion' | 'all' | string;
}

export interface GetGroupSystemMsgParams extends JsonObject {
    group_id?: number;
    only_pending?: boolean;
    count?: number;
}

export interface DeleteFriendParams extends UserIdParams {
    block?: boolean;
}

export interface SetGroupKickParams extends GroupIdParams {
    user_id: number;
    reject_add_request?: boolean;
}

export interface SetGroupKickMembersParams extends GroupIdParams {
    user_id: number[];
    reject_add_request?: boolean;
}

export interface SetGroupBanParams extends GroupIdParams {
    user_id: number;
    duration?: number;
}

export interface SetGroupWholeBanParams extends GroupIdParams {
    enable?: boolean;
}

export interface SetGroupAddOptionParams extends GroupIdParams {
    add_type: number;
    group_question?: string;
    group_answer?: string;
}

export interface SetGroupAdminParams extends GroupIdParams {
    user_id: number;
    enable?: boolean;
}

export interface SetGroupCardParams extends GroupIdParams {
    user_id: number;
    card?: string;
}

export interface SetGroupNameParams extends GroupIdParams {
    group_name: string;
}

export interface SetGroupSpecialTitleParams extends GroupIdParams {
    user_id: number;
    special_title?: string;
}

export type SetFriendsCategoryParams = JsonObject &
    (
        | { uin: number; categoryId: number; categoryName?: never }
        | { uin: number; categoryId?: never; categoryName: string }
    );

export interface UploadGroupFileParams extends GroupIdParams {
    file: string;
    name?: string;
    folder?: string;
    folder_id?: string;
    upload_file?: boolean;
}

export interface UploadPrivateFileParams extends UserIdParams {
    file: string;
    name?: string;
    upload_file?: boolean;
}

export interface GetGroupFileUrlParams extends GroupIdParams {
    file_id: string;
    busid?: number;
}

export interface GetGroupFilesParams extends GroupIdParams {
    folder_id?: string;
    folder?: string;
}

export interface DeleteGroupFileParams extends GroupIdParams {
    file_id: string;
}

export interface MoveGroupFileParams extends GroupIdParams {
    file_id: string;
    parent_directory: string;
    target_directory: string;
}

export interface CreateGroupFileFolderParams extends GroupIdParams {
    name: string;
    parent_id?: string;
}

export interface DeleteGroupFileFolderParams extends GroupIdParams {
    folder_id: string;
}

export interface RenameGroupFileFolderParams extends GroupIdParams {
    folder_id: string;
    new_folder_name?: string;
    name?: string;
}

export interface GetPrivateFileUrlParams extends UserIdParams {
    file_id: string;
    file_hash: string;
}

export interface SetFriendAddRequestParams extends JsonObject {
    flag: string;
    approve?: boolean;
}

export interface SetGroupAddRequestParams extends JsonObject {
    flag: string;
    sub_type?: string;
    type?: string;
    approve?: boolean;
    reason?: string;
}

export interface SendLikeParams extends UserIdParams {
    times?: number;
}

export interface FriendPokeParams extends UserIdParams {
    target_id?: number;
}

export interface GroupPokeParams extends GroupIdParams {
    user_id: number;
}

export interface SendPokeParams extends UserIdParams {
    group_id?: number;
}

export interface SetGroupReactionParams extends JsonObject {
    message_id: number;
    code: string;
    group_id?: number;
    is_set?: boolean;
}

export interface GetMessageHistoryParams extends JsonObject {
    message_id?: number;
    count?: number;
    /** With a non-zero message_id, include the anchor and query older (`true`) or newer (`false`) messages. Defaults to `true`. */
    reverse_order?: boolean;
}

export interface GetGroupMessageHistoryParams extends GroupIdParams, GetMessageHistoryParams {}
export interface GetFriendMessageHistoryParams extends UserIdParams, GetMessageHistoryParams {}

export interface MarkGroupMsgAsReadParams extends JsonObject {
    message_id: number;
    group_id?: number;
}

export interface MarkPrivateMsgAsReadParams extends JsonObject {
    message_id: number;
    user_id?: number;
}

export interface MarkMsgAsReadParams extends JsonObject {
    message_id: number;
    target_id?: number;
}

export interface GroupNoticeParams extends GroupIdParams {
    content: string;
    image?: string;
    pinned?: 0 | 1;
    /** Compatibility field: 1=regular announcement, 20=new-member announcement. */
    type?: 1 | 20;
    send_to_new_members?: boolean;
    is_show_edit_card?: 0 | 1;
    /** QQ's raw inverted field: 0=show popup, 1=do not show popup. */
    tip_window_type?: 0 | 1;
    confirm_required?: 0 | 1;
}

export interface ForwardPreviewParams {
    // Header above the preview ("群聊的聊天记录"). Default: "聊天记录" / nicks.
    source?: string;
    // Per-line preview entries ("nick: text"). Default: derived from nodes.
    news?: Array<{ text: string }>;
    // Grey footer ("查看 N 条转发消息"). Default: "查看 N 条转发消息".
    summary?: string;
    // Chat-list brief ("[聊天记录]"). Default: "[聊天记录]".
    prompt?: string;
}

export interface ForwardMessageParams extends JsonObject, ForwardPreviewParams {
    message_type?: 'private' | 'group' | string;
    user_id?: number;
    group_id?: number;
    message?: JsonValue;
    messages?: JsonValue;
}

export interface GroupForwardMessageParams extends GroupIdParams, ForwardPreviewParams {
    message?: JsonValue;
    messages?: JsonValue;
}

export interface PrivateForwardMessageParams extends UserIdParams, ForwardPreviewParams {
    message?: JsonValue;
    messages?: JsonValue;
}

export interface GetForwardMsgParams extends JsonObject {
    id?: string;
    message_id?: number | string;
}

export interface GetMediaParams extends JsonObject {
    file?: string;
    file_id?: string;
}

export interface DomainParams extends JsonObject {
    domain?: string;
}

export interface QuickOperationParams extends JsonObject {
    context: JsonObject;
    operation: JsonObject;
}

export interface SetFriendRemarkParams extends UserIdParams {
    remark: string;
}

export interface SetGroupRemarkParams extends GroupIdParams {
    remark: string;
}

export interface SetMsgEmojiLikeParams extends JsonObject {
    message_id: number;
    emoji_id: string;
    set?: boolean;
}

export interface FetchCustomFaceParams extends JsonObject {
    count?: number;
}

export type SendCustomFaceParams = JsonObject & {
    /** Saved sticker resource ID or its 32-character content MD5. */
    emoji_id: string;
    reply_to?: number;
} & ({ group_id: number; user_id?: never } | { user_id: number; group_id?: never });

export interface FetchSysFacesParams extends JsonObject {
    refresh?: boolean;
}

export interface FetchFaceEntityParams extends FetchSysFacesParams {
    face_id: number;
}

export interface SearchSysFacesParams extends JsonObject {
    query: string;
}

export interface GetCollectionListParams extends JsonObject {
    /** Collection category ID; 0 returns every category. */
    category?: number;
    /** Maximum number of collection items to return (1-500). */
    count?: number;
}

export interface GetEmojiLikesParams extends MessageIdParams {
    emoji_id: string;
}

export interface FetchEmojiLikeParams extends MessageIdParams {
    emojiId: string;
    emojiType?: number;
    count?: number;
    cookie?: string;
}

export interface DownloadFileParams extends JsonObject {
    url?: string;
    base64?: string;
    name?: string;
    headers?: string | string[];
}

export interface SetQqProfileParams extends JsonObject {
    nickname?: string;
    personal_note?: string;
    sex?: number;
}

export interface SetOnlineStatusParams extends JsonObject {
    status: number;
    ext_status?: number;
    battery_status?: number;
}

// DIY online status — status/extStatus are forced to 10/2000 server-side,
// and these three fields land in the customExt sub-message.
export interface SetDiyOnlineStatusParams extends JsonObject {
    face_id: number | string;
    wording?: string;
    face_type?: number | string;
}

// nc_get_user_status — read the QQ-side online/ext-status word for a uin.
export interface NcGetUserStatusParams extends UserIdParams {}

// set_/complete_/cancel_group_todo all share this shape; the action verb
// lives in the route, not the body.
export interface GroupTodoParams extends GroupIdParams {
    message_id: number | string;
}

// AI voice — fetch the in-group AI character list.
export interface GetAiCharactersParams extends GroupIdParams {
    chat_type?: number | string;
}

// AI voice — `get_ai_record` and `send_group_ai_record` share params.
// The action's verb (read vs send) is the route, not the body.
export interface AiVoiceParams extends GroupIdParams {
    character: string;
    text: string;
    chat_type?: number | string;
}

// delete_group_folder — napcat's alias for delete_group_file_folder.
// Same body, different action name.
export interface DeleteGroupFolderParams extends GroupIdParams {
    folder_id: string;
}

// send_packet — debug endpoint, sends a hex-encoded raw packet.
// `rsp=false` skips waiting for a response.
export interface SendPacketParams extends JsonObject {
    cmd: string;
    data?: string;
    rsp?: boolean;
}

export interface GetQzoneMsgDetailParams extends JsonObject {
    tid: string;
    /** Post owner; defaults to the current account. */
    target_uin?: number | string;
    /** Top-level comment offset (default 0). */
    pos?: number | string;
    /** Requested page size, 1–100 (default 20); Qzone may return fewer. */
    num?: number | string;
}

/** Numeric action fields also accept numeric strings; bounds are checked by the server. */
export type ActionNumberInput = number | string;
/** String action fields preserve the server's number/boolean coercion. */
export type ActionStringInput = string | number | boolean;
/** Boolean fields accept numbers and strings such as true/false, yes/no and on/off. */
export type ActionBooleanInput = boolean | number | string;

export interface ActionGroupIdParams extends JsonObject {
    group_id: ActionNumberInput;
}

export interface ActionUserIdParams extends JsonObject {
    user_id: ActionNumberInput;
}

export interface ActionMessageIdParams extends JsonObject {
    /** Non-zero signed message ID; negative values are valid. */
    message_id: ActionNumberInput;
}

/** Both IDs may be supplied; these actions give group_id precedence. */
export type ActionPeerParams = JsonObject &
    (
        | { group_id: ActionNumberInput; user_id?: ActionNumberInput }
        | { user_id: ActionNumberInput; group_id?: ActionNumberInput }
    );

export interface AddCustomFaceParams extends JsonObject {
    file: ActionStringInput;
}

export interface CustomFaceIdParams extends JsonObject {
    emoji_id: ActionStringInput;
}

export interface ModifyCustomFaceParams extends CustomFaceIdParams {
    desc?: ActionStringInput;
}

export interface FetchCustomFaceDetailParams extends JsonObject {
    count?: ActionNumberInput;
}

export interface GetDoubtFriendsAddRequestParams extends JsonObject {
    count?: ActionNumberInput;
}

export interface SetDoubtFriendsAddRequestParams extends JsonObject {
    flag: ActionStringInput;
    approve?: ActionBooleanInput;
}

export type SharePeerParams = ActionPeerParams & { phone_number?: ActionStringInput };

export type SendTuwenArkParams = ActionPeerParams & {
    title: ActionStringInput;
    desc: ActionStringInput;
    summary?: ActionStringInput;
    preview_url?: ActionStringInput;
    jump_url: ActionStringInput;
};

export interface RequestDecryptKeyParams extends JsonObject {
    db_path: ActionStringInput;
}

export interface SetGroupMemberInvitePolicyParams extends ActionGroupIdParams {
    policy: 'disabled' | 'require_approval' | 'no_approval' | 'no_approval_under_100';
}

export interface SetGroupNewMemberHistoryVisibilityParams extends ActionGroupIdParams {
    visible: ActionBooleanInput;
}

export interface GroupAdminTargetParams extends ActionGroupIdParams {
    user_id: ActionNumberInput;
}

export type GroupAdminKickLimit = 0 | 5 | 10 | 20 | 50 | 100 | 200;

/** Only supplied permissions change. Enabling removal requires an explicit limit. */
export type SetGroupAdminPermissionsParams = GroupAdminTargetParams &
    (
        | {
              recall_member_message: ActionBooleanInput;
              kick_member?: never;
              kick_member_per_day?: never;
          }
        | {
              recall_member_message?: ActionBooleanInput;
              kick_member: false;
              kick_member_per_day?: never;
          }
        | {
              recall_member_message?: ActionBooleanInput;
              kick_member: true;
              kick_member_per_day: GroupAdminKickLimit | `${GroupAdminKickLimit}`;
          }
    );

export interface SetGroupAdminReceiveVerifyParams extends GroupAdminTargetParams {
    enable: ActionBooleanInput;
}

export type SetGroupMemberPermissionsParams = ActionGroupIdParams &
    (
        | {
              allow_member_upload_album: ActionBooleanInput;
              allow_member_temporary_session?: ActionBooleanInput;
              allow_member_create_group?: ActionBooleanInput;
          }
        | {
              allow_member_upload_album?: ActionBooleanInput;
              allow_member_temporary_session: ActionBooleanInput;
              allow_member_create_group?: ActionBooleanInput;
          }
        | {
              allow_member_upload_album?: ActionBooleanInput;
              allow_member_temporary_session?: ActionBooleanInput;
              allow_member_create_group: ActionBooleanInput;
          }
    );

export interface SetGroupRobotAddOptionParams extends ActionGroupIdParams {
    robot_member_switch?: ActionNumberInput;
    robot_member_examine?: ActionNumberInput;
}

export interface GetQunAlbumListParams extends ActionGroupIdParams {
    attach_info?: ActionStringInput;
}

export interface GroupAlbumParams extends ActionGroupIdParams {
    album_id: ActionStringInput;
}

export interface UploadGroupAlbumMediaParams extends GroupAlbumParams {
    album_name: ActionStringInput;
    file: ActionStringInput;
}

export interface GetGroupAlbumMediaListParams extends GroupAlbumParams {
    attach_info?: ActionStringInput;
}

export interface GroupAlbumMediaParams extends GroupAlbumParams {
    /** Photo locator or video ID. */
    lloc: ActionStringInput;
}

export interface GroupAlbumCommentParams extends GroupAlbumMediaParams {
    content: ActionStringInput;
}

export interface GroupAlbumMediaLikeParams extends GroupAlbumParams {
    batch_id: ActionStringInput;
    lloc?: ActionStringInput;
}

export interface GetQzoneMsgListParams extends JsonObject {
    target_uin?: ActionNumberInput;
    pos?: ActionNumberInput;
    num?: ActionNumberInput;
}

export interface GetQzoneFeedsParams extends JsonObject {
    /** Starts at 1. Without a cursor, earlier pages are traversed to reach this page. */
    page_num?: ActionNumberInput;
    count?: ActionNumberInput;
    /** Pass next_cursor unchanged for the same account; omit page_num when continuing. */
    cursor?: string;
}

export interface GetQzoneProfileParams extends JsonObject {
    /** Defaults to the current account's space. */
    target_uin?: ActionNumberInput;
}

/** Updates the current account's space; omitted fields are preserved. */
export type SetQzoneProfileParams = JsonObject &
    (
        | { name: ActionStringInput; description?: ActionStringInput }
        | { name?: ActionStringInput; description: ActionStringInput }
    );

/** Non-empty text or a non-empty array of upstream rich-text items. */
export type QzonePublicContent = string | JsonObject[];

export interface GetQzonePublicFeedsParams extends JsonObject {
    /** Opaque account-bound next_cursor from the previous page. */
    cursor?: string;
}

export interface QzonePublicFeedParams extends JsonObject {
    /** The original feed cells returned in get_qzone_public_feeds.feeds. */
    feed: JsonObject;
}

export interface GetQzonePublicCommentsParams extends QzonePublicFeedParams {
    /** Upstream attach_info from the detail or previous comment page. */
    cursor: string;
}

export interface QzonePublicCommentParams extends QzonePublicFeedParams {
    /** Preserve the complete upstream parent comment. */
    comment: JsonObject;
}

export interface GetQzonePublicRepliesParams extends QzonePublicCommentParams {
    /** Omit to use comment.reply_attach_info; then pass the reply page's cursor unchanged. */
    cursor?: string;
    /** Defaults to 20; must be at least 1. */
    page_size?: ActionNumberInput;
}

export interface QzonePublicInteractionParams extends QzonePublicFeedParams {
    /** Defaults to true; false cancels the interaction. */
    enable?: ActionBooleanInput;
}

export interface SetQzonePublicCommentLikeParams extends QzonePublicCommentParams {
    /** Omit for the parent comment; provide the complete upstream reply to like that reply. */
    reply?: JsonObject;
    /** Defaults to true; false cancels the like. */
    enable?: ActionBooleanInput;
}

export interface CommentQzonePublicFeedParams extends QzonePublicFeedParams {
    content: QzonePublicContent;
}

export interface ReplyQzonePublicFeedParams extends CommentQzonePublicFeedParams {
    comment: JsonObject;
    /** Preserve a specific upstream reply when addressing its author. */
    reply?: JsonObject;
}

export interface QzonePublicReplyParams extends QzonePublicCommentParams {
    reply: JsonObject;
}

export interface ForwardQzonePublicFeedParams extends QzonePublicFeedParams {
    reason?: string;
}

export interface QzoneMsgIdParams extends JsonObject {
    tid: ActionStringInput;
}

/** 1=public, 4=friends, 16=selected friends, 64=self, 128=exclude selected friends. */
export type QzoneUgcRight = 1 | 4 | 16 | 64 | 128;

export interface SendQzoneMsgParams extends JsonObject {
    content: ActionStringInput;
    images?: ActionStringInput[];
    /** Defaults to 1. Values are validated as QzoneUgcRight by the server. */
    ugc_right?: ActionNumberInput;
    /** Required and non-empty when ugc_right is 16 or 128. */
    target_uins?: ActionNumberInput[];
}

export interface SetQzoneMsgRightParams extends QzoneMsgIdParams {
    /** One of the QzoneUgcRight values, also accepted as a numeric string. */
    ugc_right: ActionNumberInput;
    /** Required and non-empty when ugc_right is 16 or 128. */
    target_uins?: ActionNumberInput[];
}

export interface LikeQzoneParams extends QzoneMsgIdParams {
    target_uin?: ActionNumberInput;
    /** Post publication time in Unix seconds. */
    abstime?: ActionNumberInput;
}

export interface CommentQzoneParams extends QzoneMsgIdParams {
    content: ActionStringInput;
    /** Post owner, not the author being replied to. Defaults to the current account. */
    target_uin?: ActionNumberInput;
    /** Top-level parent ID, including "0". Requires comment_uin; omit for an ordinary comment. */
    comment_id?: ActionStringInput;
    /** Parent comment author from get_qzone_msg_detail. Requires comment_id. */
    comment_uin?: ActionNumberInput;
    /** Author to address inside the parent thread. Requires reply_name and a parent comment. */
    reply_uin?: ActionNumberInput;
    /** Addressed author's name from comment details. Requires reply_uin. */
    reply_name?: ActionStringInput;
    /** Ordinary comments only; non-empty images with comment_id are rejected before upload. */
    images?: ActionStringInput[];
}

export interface SetQzoneBanParams extends ActionUserIdParams {
    enable?: ActionBooleanInput;
}

export type FlashTaskFile = string | { file: string; name?: string };

export interface CreateFlashTaskParams extends JsonObject {
    /** A path, a named file, or a non-empty array mixing both forms. */
    files: FlashTaskFile | FlashTaskFile[];
    name?: ActionStringInput;
    thumb_path?: ActionStringInput;
}

export interface FilesetIdParams extends JsonObject {
    fileset_id: ActionStringInput;
}

export interface GetFlashFileUrlParams extends FilesetIdParams {
    /** Accepted for compatibility; this action selects by file_index. */
    file_name?: ActionStringInput;
    file_index?: ActionNumberInput;
}

export interface DownloadFilesetParams extends FilesetIdParams {
    file_name?: ActionStringInput;
    file_index?: ActionNumberInput;
}

export interface RenameFlashFileParams extends FilesetIdParams {
    new_name: ActionStringInput;
}

export type SendFlashMsgParams = FilesetIdParams & ActionPeerParams;

export interface GetFilesetIdParams extends JsonObject {
    share_code: ActionStringInput;
}

export interface UploadFileStreamParams extends JsonObject {
    stream_id: ActionStringInput;
    chunk_data?: ActionStringInput;
    chunk_index?: ActionNumberInput;
    /** Required when creating a stream; omitted for status, reset and later chunks. */
    total_chunks?: ActionNumberInput;
    file_size?: ActionNumberInput;
    expected_sha256?: ActionStringInput;
    is_complete?: ActionBooleanInput;
    filename?: ActionStringInput;
    reset?: ActionBooleanInput;
    verify_only?: ActionBooleanInput;
    /** Retention in milliseconds; 0 disables automatic expiry. */
    file_retention?: ActionNumberInput;
}

export type DownloadFileStreamParams = JsonObject & {
    chunk_size?: ActionNumberInput;
} & (
        | { file: ActionStringInput; file_id?: ActionStringInput }
        | { file_id: ActionStringInput; file?: ActionStringInput }
    );

export interface TestDownloadStreamParams extends JsonObject {
    error?: ActionBooleanInput;
}
