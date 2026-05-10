import type { JsonObject, JsonValue, MessageMeta } from './types';
import { RETCODE, failedResponse } from './types';

import { register as registerInfo } from './actions/info';
import { register as registerMessage } from './actions/message';
import { register as registerFriend } from './actions/friend';
import { register as registerGroupInfo } from './actions/group-info';
import { register as registerGroupAdmin } from './actions/group-admin';
import { register as registerGroupFile } from './actions/group-file';
import { register as registerRequest } from './actions/request';
import { register as registerExtended } from './actions/extended';

import { WebHonorType } from '@/bridge/web/group-honor';
// import {ClientKeyInfo} from "@/bridge/bridge";

export interface MessageSendResult {
  messageId: number;
  meta?: MessageMeta;
  echoEvent?: JsonObject;
}

export interface GroupEssenceMsgRet {
  retcode: number;
  data: {
    is_end: boolean;
    msg_list: any[];
    [key: string]: any;
  };
  [key: string]: any;
}

export interface ApiActionContext {
  getLoginInfo: () => { userId: number; nickname: string };
  isOnline: () => boolean;
  getMessage: (messageId: number) => JsonObject | null;
  getMessageMeta: (messageId: number) => MessageMeta | null;
  sendPrivateMessage?: (userId: number, message: JsonValue, autoEscape: boolean) => Promise<MessageSendResult>;
  sendGroupMessage?: (groupId: number, message: JsonValue, autoEscape: boolean) => Promise<MessageSendResult>;
  deleteMessage?: (messageId: number, meta: MessageMeta) => Promise<void>;
  canSendImage?: () => boolean;
  canSendRecord?: () => boolean;
  // Info retrieval (async — triggers OIDB fetch)
  getFriendList?: () => Promise<JsonObject[]>;
  getGroupList?: (noCache?: boolean) => Promise<JsonObject[]>;
  getGroupInfo?: (groupId: number, noCache?: boolean) => Promise<JsonObject | null>;
  getGroupMemberList?: (groupId: number, noCache?: boolean) => Promise<JsonObject[]>;
  getGroupMemberInfo?: (groupId: number, userId: number, noCache?: boolean) => Promise<JsonObject | null>;
  getStrangerInfo?: (userId: number) => Promise<JsonObject | null>;
  // Group admin
  setGroupKick?: (groupId: number, userId: number, rejectAdd: boolean) => Promise<void>;
  setGroupKickMembers?: (groupId: number, userIds: number[], rejectAdd: boolean) => Promise<void>;
  setGroupBan?: (groupId: number, userId: number, duration: number) => Promise<void>;
  setGroupWholeBan?: (groupId: number, enable: boolean) => Promise<void>;
  setGroupAddOption?: (groupId: number, addType: number) => Promise<void>;
  setGroupSearch?: (groupId: number) => Promise<void>;
  setGroupAdmin?: (groupId: number, userId: number, enable: boolean) => Promise<void>;
  setGroupCard?: (groupId: number, userId: number, card: string) => Promise<void>;
  setGroupName?: (groupId: number, name: string) => Promise<void>;
  setGroupLeave?: (groupId: number) => Promise<void>;
  setGroupSpecialTitle?: (groupId: number, userId: number, title: string) => Promise<void>;
  getGroupAtAllRemain?: (groupId: number) => Promise<any>;
  // Group file
  uploadGroupFile?: (groupId: number, file: string, name?: string, folderId?: string, uploadFile?: boolean) => Promise<string | null>;
  uploadPrivateFile?: (userId: number, file: string, name?: string, uploadFile?: boolean) => Promise<string | null>;
  getGroupFileUrl?: (groupId: number, fileId: string, busId?: number) => Promise<string>;
  getGroupFiles?: (groupId: number, folderId?: string) => Promise<JsonObject>;
  deleteGroupFile?: (groupId: number, fileId: string) => Promise<void>;
  moveGroupFile?: (groupId: number, fileId: string, parentDirectory: string, targetDirectory: string) => Promise<void>;
  createGroupFileFolder?: (groupId: number, name: string, parentId?: string) => Promise<void>;
  deleteGroupFileFolder?: (groupId: number, folderId: string) => Promise<void>;
  renameGroupFileFolder?: (groupId: number, folderId: string, newName: string) => Promise<void>;
  getPrivateFileUrl?: (userId: number, fileId: string, fileHash: string) => Promise<string>;
  // Requests
  handleFriendRequest?: (flag: string, approve: boolean) => Promise<void>;
  handleGroupRequest?: (flag: string, subType: string, approve: boolean, reason: string) => Promise<void>;
  // Extended
  sendLike?: (userId: number, times: number) => Promise<void>;
  sendFriendPoke?: (userId: number, targetId?: number) => Promise<void>;
  sendGroupPoke?: (groupId: number, userId: number) => Promise<void>;
  setEssenceMsg?: (messageId: number) => Promise<void>;
  deleteEssenceMsg?: (messageId: number) => Promise<void>;
  forceFetchClientKey? : () => Promise<{clientKey: string, keyIndex: string, expireTime: string}>;
  setOnlineStatus?: (status: number, extStatus?: number, batteryStatus?: number) => Promise<void>;
  setProfile?: (nickname?: string, personalNote?: string) => Promise<void>;
  getUnidirectionalFriendList?: () => Promise<any>;
  setSelfLongNick?: (longNick: string) => Promise<void>;
  setInputStatus?: (userId: number, eventType: number) => Promise<void>;
  translateEn2Zh?: (words: string[]) => Promise<string[]>;
  getMiniAppArk?: (type: string, title: string, desc: string, picUrl: string, jumpUrl: string) => Promise<any>;
  clickInlineKeyboardButton?: (groupId: number, botAppid: number, buttonId: string, callbackData: string, msgSeq: number) => Promise<any>;
  sendGroupSign?: (groupId: number) => Promise<void>;
  // New context methods
  setGroupReaction?: (groupId: number, sequence: number, code: string, isSet: boolean) => Promise<void>;
  handleDeleteFriend?: (userId: number, block?: boolean) => Promise<void>;
  getGroupMsgHistory?: (groupId: number, messageId?: number, count?: number) => Promise<JsonObject[]>;
  getFriendMsgHistory?: (userId: number, messageId?: number, count?: number) => Promise<JsonObject[]>;
  handleGetGroupSystemMsg?: () => Promise<JsonObject[]>;
  getDownloadRKeys?: () => Promise<JsonObject[]>;
  // Forward message
  sendGroupForwardMsg?: (groupId: number, messages: JsonValue) => Promise<{ messageId: number; forwardId: string }>;
  sendPrivateForwardMsg?: (userId: number, messages: JsonValue) => Promise<{ messageId: number; forwardId: string }>;
  sendForwardMsg?: (messages: JsonValue) => Promise<{ forwardId: string }>;
  getForwardMsg?: (resId: string) => Promise<JsonObject[]>;
  // Extended NapCat-compatible
  setFriendRemark?: (userId: number, remark: string) => Promise<void>;
  setGroupRemark?: (groupId: number, remark: string) => Promise<void>;
  getGroupFileCount?: (groupId: number) => Promise<{ fileCount: number; maxCount: number }>;
  setMsgEmojiLike?: (messageId: number, emojiId: string, set: boolean) => Promise<void>;
  markGroupMsgAsRead?: (groupId: number, sequence: number) => Promise<void>;
  markPrivateMsgAsRead?: (userId: number, sequence: number) => Promise<void>;
  getProfileLike?: (userId?: number, start?: number, limit?: number) => Promise<any>;
  fetchCustomFace?: (count?: number) => Promise<string[]>;
  getEmojiLikes?: (groupId: number, sequence: number, emojiId: string, emojiType?: number, count?: number, cookie?: string) => Promise<{ users: Array<{ uin: number }>, cookie: string, isLast: boolean }>;
  // Web
  getGroupHonorInfo?: (groupId: number, type: WebHonorType | string) => Promise<any>;
  getGroupEssence?: (groupId: number, pageStart?: number, pageLimit?: number) => Promise<GroupEssenceMsgRet>;
  getGroupEssenceAll?: (groupId: number) => Promise<GroupEssenceMsgRet[]>;
  sendGroupNotice?: (groupId: number, content: string, options?: any) => Promise<any>;
  getGroupNotice?: (groupId: number) => Promise<any[]>;
  deleteGroupNotice?: (groupId: number, fid: string) => Promise<boolean>;
  getCookiesStr?: (domain: string) => Promise<string>;
  getCsrfToken?: () => Promise<number>;
  getCredentials?: (domain: string) => Promise<{ cookies: string; token: number; csrf_token: number }>;
  // Media lookup (populated from previously dispatched message segments)
  getImageInfo?: (file: string) => Promise<JsonObject | null>;
  getRecordInfo?: (file: string) => Promise<JsonObject | null>;
  // Avatar
  setAvatar?: (source: string) => Promise<void>;
}

type ActionHandler = (params: JsonObject) => Promise<import('./types').ApiResponse>;

export class ApiHandler {
  private readonly handlers = new Map<string, ActionHandler>();

  constructor(context: ApiActionContext) {
    registerInfo(this, context);
    registerMessage(this, context);
    registerFriend(this, context);
    registerGroupInfo(this, context);
    registerGroupAdmin(this, context);
    registerGroupFile(this, context);
    registerRequest(this, context);
    registerExtended(this, context);
  }

  registerAction(action: string, handler: ActionHandler): void {
    this.handlers.set(action, handler);
  }

  async handle(action: string, params: JsonObject): Promise<import('./types').ApiResponse> {
    const handler = this.handlers.get(action);
    if (!handler) {
      return failedResponse(RETCODE.UNKNOWN_ACTION, 'unknown action');
    }

    try {
      return await handler(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal error';
      return failedResponse(RETCODE.INTERNAL_ERROR, message);
    }
  }

  async processRequest(rawRequest: string): Promise<string> {
    if (!rawRequest.trim()) {
      return JSON.stringify(failedResponse(RETCODE.BAD_REQUEST, 'bad request'));
    }

    try {
      const parsed = JSON.parse(rawRequest) as unknown;
      if (!isJsonObject(parsed)) {
        return JSON.stringify(failedResponse(RETCODE.BAD_REQUEST, 'bad request'));
      }

      const action = asString(parsed.action);
      if (!action) {
        return JSON.stringify(failedResponse(RETCODE.BAD_REQUEST, 'bad request'));
      }

      const params = isJsonObject(parsed.params) ? parsed.params : {};
      const echo = parsed.echo;
      const response = await this.handle(action, params);
      if (echo !== undefined) {
        response.echo = toJsonValue(echo);
      }

      return JSON.stringify(response);
    } catch {
      return JSON.stringify(failedResponse(RETCODE.BAD_REQUEST, 'bad request'));
    }
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return 0;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
  }
  return fallback;
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isJsonObject(value)) {
    const obj: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      obj[key] = toJsonValue(item);
    }
    return obj;
  }
  return String(value);
}

export function asMessage(value: unknown): import('./types').JsonValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return toJsonValue(parsed);
        }
      } catch {
        // Fallback to literal text if it just looks like an array but is invalid JSON
      }
    }
  }
  return toJsonValue(value);
}
