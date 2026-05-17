import type { JsonArray, JsonObject, JsonValue } from './json';
import type {
  CreateGroupFileFolderParams,
  DeleteFriendParams,
  DeleteGroupFileFolderParams,
  DeleteGroupFileParams,
  DomainParams,
  DownloadFileParams,
  FetchCustomFaceParams,
  FetchEmojiLikeParams,
  ForwardMessageParams,
  FriendPokeParams,
  GetEmojiLikesParams,
  GetForwardMsgParams,
  GetFriendMessageHistoryParams,
  GetGroupFilesParams,
  GetGroupFileUrlParams,
  GetGroupHonorInfoParams,
  GetGroupInfoParams,
  GetGroupListParams,
  GetGroupMemberInfoParams,
  GetGroupMemberListParams,
  GetGroupMessageHistoryParams,
  GetMediaParams,
  GetPrivateFileUrlParams,
  GroupForwardMessageParams,
  GroupIdParams,
  GroupNoticeParams,
  GroupPokeParams,
  MarkGroupMsgAsReadParams,
  MarkMsgAsReadParams,
  MarkPrivateMsgAsReadParams,
  MessageIdParams,
  MoveGroupFileParams,
  PrivateForwardMessageParams,
  RenameGroupFileFolderParams,
  SendGroupMsgParams,
  SendLikeParams,
  SendMsgParams,
  SendPokeParams,
  SendPrivateMsgParams,
  SetFriendAddRequestParams,
  SetFriendRemarkParams,
  SetGroupAddRequestParams,
  SetGroupAddOptionParams,
  SetGroupAdminParams,
  SetGroupBanParams,
  SetGroupCardParams,
  SetGroupKickParams,
  SetGroupKickMembersParams,
  SetGroupNameParams,
  SetGroupRemarkParams,
  SetGroupReactionParams,
  SetGroupSpecialTitleParams,
  SetGroupWholeBanParams,
  SetMsgEmojiLikeParams,
  SetOnlineStatusParams,
  SetQqProfileParams,
  UploadGroupFileParams,
  UploadPrivateFileParams,
  UserIdParams,
  QuickOperationParams,
  SetDiyOnlineStatusParams,
  NcGetUserStatusParams,
  GroupTodoParams,
  GetAiCharactersParams,
  AiVoiceParams,
  DeleteGroupFolderParams,
  SendPacketParams,
} from './params';
import type {
  CapabilityInfo,
  ClientKeyInfo,
  CookieInfo,
  CredentialsInfo,
  CsrfInfo,
  DownloadFileResult,
  EmptyData,
  ForwardMessageResult,
  FriendMessageHistory,
  GroupAtAllRemainInfo,
  GroupFileSystemInfo,
  GroupFileUrl,
  GroupMessageHistory,
  LoginInfo,
  MediaInfo,
  OnlineClientsInfo,
  PrivateFileUrl,
  SendMessageResult,
  StatusInfo,
  UploadForwardResult,
  UrlSafetyInfo,
  VersionInfo,
  AiCharacterCategory,
  UserOnlineStatus,
  SendGroupAiRecordResult,
} from './results';

export type ActionData = JsonValue;

export interface SnowLumaActionMap {
  get_login_info: { params: JsonObject; data: LoginInfo };
  get_status: { params: JsonObject; data: StatusInfo };
  get_version_info: { params: JsonObject; data: VersionInfo };
  can_send_image: { params: JsonObject; data: CapabilityInfo };
  can_send_record: { params: JsonObject; data: CapabilityInfo };
  send_msg: { params: SendMsgParams; data: SendMessageResult };
  send_private_msg: { params: SendPrivateMsgParams; data: SendMessageResult };
  send_group_msg: { params: SendGroupMsgParams; data: SendMessageResult };
  get_msg: { params: MessageIdParams; data: JsonObject };
  delete_msg: { params: MessageIdParams; data: EmptyData };
  get_friend_list: { params: JsonObject; data: JsonObject[] };
  get_stranger_info: { params: UserIdParams; data: JsonObject };
  delete_friend: { params: DeleteFriendParams; data: EmptyData };
  get_group_list: { params: GetGroupListParams; data: JsonObject[] };
  get_group_info: { params: GetGroupInfoParams; data: JsonObject };
  get_group_member_list: { params: GetGroupMemberListParams; data: JsonObject[] };
  get_group_member_info: { params: GetGroupMemberInfoParams; data: JsonObject };
  get_group_honor_info: { params: GetGroupHonorInfoParams; data: JsonValue };
  get_group_system_msg: { params: JsonObject; data: JsonObject[] };
  set_group_kick: { params: SetGroupKickParams; data: EmptyData };
  set_group_kick_members: { params: SetGroupKickMembersParams; data: EmptyData };
  set_group_ban: { params: SetGroupBanParams; data: EmptyData };
  set_group_whole_ban: { params: SetGroupWholeBanParams; data: EmptyData };
  set_group_add_option: { params: SetGroupAddOptionParams; data: EmptyData };
  set_group_search: { params: GroupIdParams; data: EmptyData };
  set_group_admin: { params: SetGroupAdminParams; data: EmptyData };
  set_group_card: { params: SetGroupCardParams; data: EmptyData };
  set_group_name: { params: SetGroupNameParams; data: EmptyData };
  set_group_leave: { params: GroupIdParams; data: EmptyData };
  set_group_special_title: { params: SetGroupSpecialTitleParams; data: EmptyData };
  set_group_anonymous: { params: JsonObject; data: EmptyData };
  set_group_anonymous_ban: { params: JsonObject; data: EmptyData };
  set_group_portrait: { params: JsonObject; data: EmptyData };
  upload_group_file: { params: UploadGroupFileParams; data: { file_id: string | null } };
  upload_private_file: { params: UploadPrivateFileParams; data: { file_id: string | null } };
  get_group_file_url: { params: GetGroupFileUrlParams; data: GroupFileUrl };
  get_group_root_files: { params: GroupIdParams; data: JsonObject };
  get_group_files_by_folder: { params: GetGroupFilesParams; data: JsonObject };
  delete_group_file: { params: DeleteGroupFileParams; data: EmptyData };
  move_group_file: { params: MoveGroupFileParams; data: EmptyData };
  create_group_file_folder: { params: CreateGroupFileFolderParams; data: EmptyData };
  delete_group_file_folder: { params: DeleteGroupFileFolderParams; data: EmptyData };
  rename_group_file_folder: { params: RenameGroupFileFolderParams; data: EmptyData };
  get_private_file_url: { params: GetPrivateFileUrlParams; data: PrivateFileUrl };
  set_friend_add_request: { params: SetFriendAddRequestParams; data: EmptyData };
  set_group_add_request: { params: SetGroupAddRequestParams; data: EmptyData };
  send_like: { params: SendLikeParams; data: EmptyData };
  friend_poke: { params: FriendPokeParams; data: EmptyData };
  group_poke: { params: GroupPokeParams; data: EmptyData };
  send_poke: { params: SendPokeParams; data: EmptyData };
  set_essence_msg: { params: MessageIdParams; data: EmptyData };
  delete_essence_msg: { params: MessageIdParams; data: EmptyData };
  get_essence_msg_list: { params: GroupIdParams; data: JsonArray };
  set_group_reaction: { params: SetGroupReactionParams; data: EmptyData };
  get_group_msg_history: { params: GetGroupMessageHistoryParams; data: GroupMessageHistory };
  get_friend_msg_history: { params: GetFriendMessageHistoryParams; data: FriendMessageHistory };
  mark_group_msg_as_read: { params: MarkGroupMsgAsReadParams; data: EmptyData };
  mark_private_msg_as_read: { params: MarkPrivateMsgAsReadParams; data: EmptyData };
  mark_msg_as_read: { params: MarkMsgAsReadParams; data: EmptyData };
  get_rkey: { params: JsonObject; data: JsonObject[] };
  ocr_image: { params: JsonObject; data: JsonValue };
  '.ocr_image': { params: JsonObject; data: JsonValue };
  _send_group_notice: { params: GroupNoticeParams; data: EmptyData };
  _get_group_notice: { params: GroupIdParams; data: JsonArray };
  _del_group_notice: { params: JsonObject; data: EmptyData };
  upload_forward_msg: { params: ForwardMessageParams; data: UploadForwardResult };
  upload_foward_msg: { params: ForwardMessageParams; data: UploadForwardResult };
  send_forward_msg: { params: ForwardMessageParams; data: ForwardMessageResult };
  send_group_forward_msg: { params: GroupForwardMessageParams; data: ForwardMessageResult };
  send_private_forward_msg: { params: PrivateForwardMessageParams; data: ForwardMessageResult };
  get_forward_msg: { params: GetForwardMsgParams; data: { messages: JsonObject[] } };
  get_image: { params: GetMediaParams; data: MediaInfo };
  get_record: { params: GetMediaParams; data: MediaInfo };
  get_cookies: { params: DomainParams; data: CookieInfo };
  get_csrf_token: { params: JsonObject; data: CsrfInfo };
  get_credentials: { params: DomainParams; data: CredentialsInfo };
  set_restart: { params: JsonObject; data: EmptyData };
  clean_cache: { params: JsonObject; data: EmptyData };
  '.handle_quick_operation': { params: QuickOperationParams; data: EmptyData };
  set_friend_remark: { params: SetFriendRemarkParams; data: EmptyData };
  set_group_remark: { params: SetGroupRemarkParams; data: EmptyData };
  set_msg_emoji_like: { params: SetMsgEmojiLikeParams; data: EmptyData };
  _mark_all_as_read: { params: JsonObject; data: EmptyData };
  get_group_file_system_info: { params: GroupIdParams; data: GroupFileSystemInfo };
  check_url_safely: { params: JsonObject; data: UrlSafetyInfo };
  download_file: { params: DownloadFileParams; data: DownloadFileResult };
  set_qq_profile: { params: SetQqProfileParams; data: EmptyData };
  set_online_status: { params: SetOnlineStatusParams; data: EmptyData };
  get_group_ignored_notifies: { params: JsonObject; data: JsonArray };
  get_group_shut_list: { params: JsonObject; data: JsonArray };
  forward_friend_single_msg: { params: JsonObject; data: JsonValue };
  forward_group_single_msg: { params: JsonObject; data: JsonValue };
  get_recent_contact: { params: JsonObject; data: JsonArray };
  get_profile_like: { params: JsonObject; data: JsonObject };
  fetch_custom_face: { params: FetchCustomFaceParams; data: string[] };
  get_emoji_likes: { params: GetEmojiLikesParams; data: JsonObject };
  fetch_emoji_like: { params: FetchEmojiLikeParams; data: JsonObject };
  get_friends_with_category: { params: JsonObject; data: JsonObject[] };
  get_online_clients: { params: JsonObject; data: OnlineClientsInfo };
  _get_model_show: { params: JsonObject; data: { variants: JsonArray } };
  _set_model_show: { params: JsonObject; data: EmptyData };
  '.get_word_slices': { params: JsonObject; data: JsonValue };
  get_group_at_all_remain: { params: JsonObject; data: GroupAtAllRemainInfo };
  get_unidirectional_friend_list: { params: JsonObject; data: JsonArray };
  set_self_longnick: { params: JsonObject; data: EmptyData };
  get_collection_list: { params: JsonObject; data: JsonArray };
  create_collection: { params: JsonObject; data: JsonValue };
  set_qq_avatar: { params: JsonObject; data: EmptyData };
  set_input_status: { params: JsonObject; data: EmptyData };
  translate_en2zh: { params: JsonObject; data: JsonValue };
  get_clientkey: { params: JsonObject; data: ClientKeyInfo };
  get_mini_app_ark: { params: JsonObject; data: JsonValue };
  click_inline_keyboard_button: { params: JsonObject; data: JsonValue };
  set_group_sign: { params: JsonObject; data: EmptyData };
  send_group_sign: { params: JsonObject; data: EmptyData };
  get_group_info_ex: { params: GroupIdParams; data: JsonObject };
  get_group_detail_info: { params: GroupIdParams; data: JsonObject };
  trans_group_file: { params: JsonObject; data: JsonValue };
  rename_group_file: { params: JsonObject; data: JsonValue };
  get_file: { params: GetMediaParams; data: JsonValue };
  '.send_packet': { params: SendPacketParams; data: string };

  // — napcat-parity extensions (Tier 1 + Tier 2) —
  send_packet: { params: SendPacketParams; data: string };
  bot_exit: { params: JsonObject; data: EmptyData };
  nc_get_packet_status: { params: JsonObject; data: JsonValue };
  nc_get_rkey: { params: JsonObject; data: JsonObject[] };
  nc_get_user_status: { params: NcGetUserStatusParams; data: UserOnlineStatus };
  get_group_ignore_add_request: { params: JsonObject; data: JsonArray };
  delete_group_folder: { params: DeleteGroupFolderParams; data: EmptyData };
  set_group_todo: { params: GroupTodoParams; data: EmptyData };
  complete_group_todo: { params: GroupTodoParams; data: EmptyData };
  cancel_group_todo: { params: GroupTodoParams; data: EmptyData };

  // — Tier 3: DIY status —
  set_diy_online_status: { params: SetDiyOnlineStatusParams; data: EmptyData };

  // — AI voice trio —
  get_ai_characters: { params: GetAiCharactersParams; data: AiCharacterCategory[] };
  get_ai_record: { params: AiVoiceParams; data: string };
  send_group_ai_record: { params: AiVoiceParams; data: SendGroupAiRecordResult };
}

export type SnowLumaAction = keyof SnowLumaActionMap | (string & {});

export type ActionParams<TAction extends string> =
  TAction extends keyof SnowLumaActionMap ? SnowLumaActionMap[TAction]['params'] : JsonObject;

export type ActionResult<TAction extends string> =
  TAction extends keyof SnowLumaActionMap ? SnowLumaActionMap[TAction]['data'] : ActionData;
