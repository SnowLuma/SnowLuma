import type { JsonObject, JsonValue } from './json';

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
