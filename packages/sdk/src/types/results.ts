import type { JsonArray, JsonObject } from './json';

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
  platform: string;
  arch: string;
  arch_label: string;
  release: string;
  distro: string;
}

export interface VersionInfo {
  app_name: string;
  app_version: string;
  protocol_version: string;
  node_version: string;
  platform: string;
  arch: string;
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

export interface OnlineClientsInfo {
  clients: JsonArray;
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

// — send_group_ai_record 返回（合成是异步副作用，message_id 总为 0） —
export interface SendGroupAiRecordResult {
  message_id: number;
}
