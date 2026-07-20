import type { JsonObject, JsonValue } from './json';

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
    image: Array<{ id: string; height: number; width: number }>;
    images: Array<{ id: string; height: number; width: number }>;
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

export interface UrlSafetyInfo {
  level: number;
}

export interface GroupAtAllRemainInfo {
  can_at_all: boolean;
  remain_at_all_count_for_group: number;
  remain_at_all_count_for_uin: number;
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
