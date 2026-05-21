import { createSnowLumaApiError } from '../errors';
import { normalizeMessage } from '../messages/index';
import type {
  ActionParams,
  ActionResult,
  ApiResponse,
  DomainParams,
  DownloadFileParams,
  ForwardMessageParams,
  GetForwardMsgParams,
  GetFriendMessageHistoryParams,
  GetGroupHonorInfoParams,
  GetGroupMessageHistoryParams,
  GetMediaParams,
  JsonObject,
  JsonValue,
  OutgoingMessage,
  RequestOptions,
  SendMsgParams,
  SetGroupReactionParams,
  SnowLumaAction,
} from '../types/index';

/**
 * Base class for SnowLuma API clients.
 *
 * Concrete transports implement request(); this facade adds typed OneBot actions,
 * message normalization, and failed-response error handling.
 */
export abstract class SnowLumaApiClient {
  /** Sends a raw OneBot action and returns the complete API response. */
  abstract request<TAction extends SnowLumaAction>(
    action: TAction,
    params?: ActionParams<TAction>,
    options?: RequestOptions,
  ): Promise<ApiResponse<ActionResult<TAction>>>;

  /** Sends a OneBot action and returns data, throwing SnowLumaApiError on failed responses. */
  async call<TAction extends SnowLumaAction>(
    action: TAction,
    params?: ActionParams<TAction>,
    options?: RequestOptions,
  ): Promise<ActionResult<TAction>> {
    const response = await this.request(action, params, options);
    if (response.status !== 'ok' || response.retcode !== 0) {
      throw createSnowLumaApiError(response);
    }
    return response.data;
  }

  getLoginInfo(options?: RequestOptions) {
    return this.call('get_login_info', {}, options);
  }

  getStatus(options?: RequestOptions) {
    return this.call('get_status', {}, options);
  }

  getVersionInfo(options?: RequestOptions) {
    return this.call('get_version_info', {}, options);
  }

  canSendImage(options?: RequestOptions) {
    return this.call('can_send_image', {}, options);
  }

  canSendRecord(options?: RequestOptions) {
    return this.call('can_send_record', {}, options);
  }

  sendMsg(params: Omit<SendMsgParams, 'message'> & { message: OutgoingMessage }, options?: RequestOptions) {
    return this.call('send_msg', { ...params, message: normalizeMessage(params.message) as JsonValue }, options);
  }

  sendPrivateMessage(userId: number, message: OutgoingMessage, options?: RequestOptions & { autoEscape?: boolean }) {
    return this.call('send_private_msg', {
      user_id: userId,
      message: normalizeMessage(message) as JsonValue,
      auto_escape: options?.autoEscape,
    }, options);
  }

  sendGroupMessage(groupId: number, message: OutgoingMessage, options?: RequestOptions & { autoEscape?: boolean }) {
    return this.call('send_group_msg', {
      group_id: groupId,
      message: normalizeMessage(message) as JsonValue,
      auto_escape: options?.autoEscape,
    }, options);
  }

  getMessage(messageId: number, options?: RequestOptions) {
    return this.call('get_msg', { message_id: messageId }, options);
  }

  deleteMessage(messageId: number, options?: RequestOptions) {
    return this.call('delete_msg', { message_id: messageId }, options);
  }

  getFriendList(options?: RequestOptions) {
    return this.call('get_friend_list', {}, options);
  }

  getStrangerInfo(userId: number, options?: RequestOptions) {
    return this.call('get_stranger_info', { user_id: userId }, options);
  }

  deleteFriend(userId: number, options?: RequestOptions & { block?: boolean }) {
    return this.call('delete_friend', { user_id: userId, block: options?.block }, options);
  }

  getGroupList(options?: RequestOptions & { noCache?: boolean }) {
    return this.call('get_group_list', { no_cache: options?.noCache }, options);
  }

  getGroupInfo(groupId: number, options?: RequestOptions & { noCache?: boolean }) {
    return this.call('get_group_info', { group_id: groupId, no_cache: options?.noCache }, options);
  }

  getGroupMemberList(groupId: number, options?: RequestOptions & { noCache?: boolean }) {
    return this.call('get_group_member_list', { group_id: groupId, no_cache: options?.noCache }, options);
  }

  getGroupMemberInfo(groupId: number, userId: number, options?: RequestOptions & { noCache?: boolean }) {
    return this.call('get_group_member_info', {
      group_id: groupId,
      user_id: userId,
      no_cache: options?.noCache,
    }, options);
  }

  getGroupHonorInfo(params: GetGroupHonorInfoParams, options?: RequestOptions) {
    return this.call('get_group_honor_info', params, options);
  }

  getGroupSystemMessages(options?: RequestOptions) {
    return this.call('get_group_system_msg', {}, options);
  }

  setGroupKick(groupId: number, userId: number, options?: RequestOptions & { rejectAddRequest?: boolean }) {
    return this.call('set_group_kick', {
      group_id: groupId,
      user_id: userId,
      reject_add_request: options?.rejectAddRequest,
    }, options);
  }

  setGroupBan(groupId: number, userId: number, duration?: number, options?: RequestOptions) {
    return this.call('set_group_ban', { group_id: groupId, user_id: userId, duration }, options);
  }

  setGroupWholeBan(groupId: number, enable = true, options?: RequestOptions) {
    return this.call('set_group_whole_ban', { group_id: groupId, enable }, options);
  }

  setGroupAdmin(groupId: number, userId: number, enable = true, options?: RequestOptions) {
    return this.call('set_group_admin', { group_id: groupId, user_id: userId, enable }, options);
  }

  setGroupCard(groupId: number, userId: number, card = '', options?: RequestOptions) {
    return this.call('set_group_card', { group_id: groupId, user_id: userId, card }, options);
  }

  setGroupName(groupId: number, name: string, options?: RequestOptions) {
    return this.call('set_group_name', { group_id: groupId, group_name: name }, options);
  }

  setGroupLeave(groupId: number, options?: RequestOptions) {
    return this.call('set_group_leave', { group_id: groupId }, options);
  }

  setGroupSpecialTitle(groupId: number, userId: number, title = '', options?: RequestOptions) {
    return this.call('set_group_special_title', {
      group_id: groupId,
      user_id: userId,
      special_title: title,
    }, options);
  }

  uploadGroupFile(groupId: number, file: string, options: RequestOptions & {
    name?: string;
    folder?: string;
    folderId?: string;
    uploadFile?: boolean;
  } = {}) {
    return this.call('upload_group_file', {
      group_id: groupId,
      file,
      name: options.name,
      folder: options.folder,
      folder_id: options.folderId,
      upload_file: options.uploadFile,
    }, options);
  }

  uploadPrivateFile(userId: number, file: string, options: RequestOptions & {
    name?: string;
    uploadFile?: boolean;
  } = {}) {
    return this.call('upload_private_file', {
      user_id: userId,
      file,
      name: options.name,
      upload_file: options.uploadFile,
    }, options);
  }

  getGroupFileUrl(groupId: number, fileId: string, options?: RequestOptions & { busid?: number }) {
    return this.call('get_group_file_url', { group_id: groupId, file_id: fileId, busid: options?.busid }, options);
  }

  getGroupRootFiles(groupId: number, options?: RequestOptions) {
    return this.call('get_group_root_files', { group_id: groupId }, options);
  }

  getGroupFilesByFolder(groupId: number, folderId = '/', options?: RequestOptions) {
    return this.call('get_group_files_by_folder', { group_id: groupId, folder_id: folderId }, options);
  }

  deleteGroupFile(groupId: number, fileId: string, options?: RequestOptions) {
    return this.call('delete_group_file', { group_id: groupId, file_id: fileId }, options);
  }

  moveGroupFile(groupId: number, fileId: string, parentDirectory: string, targetDirectory: string, options?: RequestOptions) {
    return this.call('move_group_file', {
      group_id: groupId,
      file_id: fileId,
      parent_directory: parentDirectory,
      target_directory: targetDirectory,
    }, options);
  }

  createGroupFileFolder(groupId: number, name: string, parentId = '/', options?: RequestOptions) {
    return this.call('create_group_file_folder', { group_id: groupId, name, parent_id: parentId }, options);
  }

  deleteGroupFileFolder(groupId: number, folderId: string, options?: RequestOptions) {
    return this.call('delete_group_file_folder', { group_id: groupId, folder_id: folderId }, options);
  }

  renameGroupFileFolder(groupId: number, folderId: string, newName: string, options?: RequestOptions) {
    return this.call('rename_group_file_folder', {
      group_id: groupId,
      folder_id: folderId,
      new_folder_name: newName,
    }, options);
  }

  getPrivateFileUrl(userId: number, fileId: string, fileHash: string, options?: RequestOptions) {
    return this.call('get_private_file_url', { user_id: userId, file_id: fileId, file_hash: fileHash }, options);
  }

  setFriendAddRequest(flag: string, approve = true, options?: RequestOptions) {
    return this.call('set_friend_add_request', { flag, approve }, options);
  }

  setGroupAddRequest(flag: string, params: RequestOptions & {
    subType?: string;
    type?: string;
    approve?: boolean;
    reason?: string;
  } = {}) {
    return this.call('set_group_add_request', {
      flag,
      sub_type: params.subType,
      type: params.type,
      approve: params.approve,
      reason: params.reason,
    }, params);
  }

  sendLike(userId: number, times = 1, options?: RequestOptions) {
    return this.call('send_like', { user_id: userId, times }, options);
  }

  friendPoke(userId: number, options?: RequestOptions & { targetId?: number }) {
    return this.call('friend_poke', { user_id: userId, target_id: options?.targetId }, options);
  }

  groupPoke(groupId: number, userId: number, options?: RequestOptions) {
    return this.call('group_poke', { group_id: groupId, user_id: userId }, options);
  }

  sendPoke(userId: number, options?: RequestOptions & { groupId?: number }) {
    return this.call('send_poke', { user_id: userId, group_id: options?.groupId }, options);
  }

  setEssenceMessage(messageId: number, options?: RequestOptions) {
    return this.call('set_essence_msg', { message_id: messageId }, options);
  }

  deleteEssenceMessage(messageId: number, options?: RequestOptions) {
    return this.call('delete_essence_msg', { message_id: messageId }, options);
  }

  getEssenceMessageList(groupId: number, options?: RequestOptions) {
    return this.call('get_essence_msg_list', { group_id: groupId }, options);
  }

  setGroupReaction(params: SetGroupReactionParams, options?: RequestOptions) {
    return this.call('set_group_reaction', params, options);
  }

  getGroupMessageHistory(params: GetGroupMessageHistoryParams, options?: RequestOptions) {
    return this.call('get_group_msg_history', params, options);
  }

  getFriendMessageHistory(params: GetFriendMessageHistoryParams, options?: RequestOptions) {
    return this.call('get_friend_msg_history', params, options);
  }

  markGroupMessageAsRead(messageId: number, groupId?: number, options?: RequestOptions) {
    return this.call('mark_group_msg_as_read', { message_id: messageId, group_id: groupId }, options);
  }

  markPrivateMessageAsRead(messageId: number, userId?: number, options?: RequestOptions) {
    return this.call('mark_private_msg_as_read', { message_id: messageId, user_id: userId }, options);
  }

  markMessageAsRead(messageId: number, targetId?: number, options?: RequestOptions) {
    return this.call('mark_msg_as_read', { message_id: messageId, target_id: targetId }, options);
  }

  getRKey(options?: RequestOptions) {
    return this.call('get_rkey', {}, options);
  }

  sendGroupNotice(groupId: number, content: string, options: RequestOptions & {
    image?: string;
    pinned?: number;
    type?: number;
    confirmRequired?: number;
  } = {}) {
    return this.call('_send_group_notice', {
      group_id: groupId,
      content,
      image: options.image,
      pinned: options.pinned,
      type: options.type,
      confirm_required: options.confirmRequired,
    }, options);
  }

  getGroupNotice(groupId: number, options?: RequestOptions) {
    return this.call('_get_group_notice', { group_id: groupId }, options);
  }

  uploadForwardMessage(params: ForwardMessageParams, options?: RequestOptions) {
    return this.call('upload_forward_msg', params, options);
  }

  sendForwardMessage(params: ForwardMessageParams, options?: RequestOptions) {
    return this.call('send_forward_msg', params, options);
  }

  sendGroupForwardMessage(groupId: number, messages: OutgoingMessage, options?: RequestOptions) {
    return this.call('send_group_forward_msg', {
      group_id: groupId,
      messages: normalizeMessage(messages) as JsonValue,
    }, options);
  }

  sendPrivateForwardMessage(userId: number, messages: OutgoingMessage, options?: RequestOptions) {
    return this.call('send_private_forward_msg', {
      user_id: userId,
      messages: normalizeMessage(messages) as JsonValue,
    }, options);
  }

  getForwardMessage(params: GetForwardMsgParams, options?: RequestOptions) {
    return this.call('get_forward_msg', params, options);
  }

  getImage(params: GetMediaParams, options?: RequestOptions) {
    return this.call('get_image', params, options);
  }

  getRecord(params: GetMediaParams, options?: RequestOptions) {
    return this.call('get_record', params, options);
  }

  getCookies(params: DomainParams = {}, options?: RequestOptions) {
    return this.call('get_cookies', params, options);
  }

  getCsrfToken(options?: RequestOptions) {
    return this.call('get_csrf_token', {}, options);
  }

  getCredentials(params: DomainParams = {}, options?: RequestOptions) {
    return this.call('get_credentials', params, options);
  }

  cleanCache(options?: RequestOptions) {
    return this.call('clean_cache', {}, options);
  }

  setFriendRemark(userId: number, remark: string, options?: RequestOptions) {
    return this.call('set_friend_remark', { user_id: userId, remark }, options);
  }

  setMsgEmojiLike(messageId: number, emojiId: string, set = true, options?: RequestOptions) {
    return this.call('set_msg_emoji_like', { message_id: messageId, emoji_id: emojiId, set }, options);
  }

  markAllAsRead(options?: RequestOptions) {
    return this.call('_mark_all_as_read', {}, options);
  }

  getGroupFileSystemInfo(groupId: number, options?: RequestOptions) {
    return this.call('get_group_file_system_info', { group_id: groupId }, options);
  }

  checkUrlSafely(options?: RequestOptions) {
    return this.call('check_url_safely', {}, options);
  }

  downloadFile(params: DownloadFileParams, options?: RequestOptions) {
    return this.call('download_file', params, options);
  }

  setQqProfile(params: { nickname?: string; personalNote?: string }, options?: RequestOptions) {
    return this.call('set_qq_profile', {
      nickname: params.nickname,
      personal_note: params.personalNote,
    }, options);
  }

  setOnlineStatus(status: number, params: RequestOptions & { extStatus?: number; batteryStatus?: number } = {}) {
    return this.call('set_online_status', {
      status,
      ext_status: params.extStatus,
      battery_status: params.batteryStatus,
    }, params);
  }

  getClientKey(options?: RequestOptions) {
    return this.call('get_clientkey', {}, options);
  }

  getGroupInfoEx(groupId: number, options?: RequestOptions) {
    return this.call('get_group_info_ex', { group_id: groupId }, options);
  }

  getGroupDetailInfo(groupId: number, options?: RequestOptions) {
    return this.call('get_group_detail_info', { group_id: groupId }, options);
  }

  /** Calls any registered SnowLuma action and returns the response data. */
  raw<TAction extends SnowLumaAction>(
    action: TAction,
    params?: ActionParams<TAction>,
    options?: RequestOptions,
  ) {
    return this.call(action, params, options);
  }

  /** Calls any registered SnowLuma action and preserves the full OneBot response envelope. */
  rawResponse<TAction extends SnowLumaAction>(
    action: TAction,
    params?: ActionParams<TAction>,
    options?: RequestOptions,
  ) {
    return this.request(action, params, options);
  }
}

export function toJsonObject(value: JsonObject | undefined): JsonObject {
  return value ?? {};
}
