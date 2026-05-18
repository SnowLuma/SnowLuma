import type { JsonObject, JsonValue, MessageMeta } from './types';
import type { ForwardPreviewMeta } from './modules/message-actions';
import type { BridgeInterface } from '../bridge/bridge-interface';
import { RETCODE, failedResponse } from './types';

import { register as registerInfo } from './actions/info';
import { register as registerMessage } from './actions/message';
import { register as registerFriend } from './actions/friend';
import { register as registerGroupInfo } from './actions/group-info';
import { register as registerGroupAdmin } from './actions/group-admin';
import { register as registerGroupFile } from './actions/group-file';
import { register as registerRequest } from './actions/request';
import { register as registerExtended } from './actions/extended';
import { register as registerGroupAlbum } from './actions/group-album';

import { WebHonorType } from '@/bridge/web/group-honor';
import { ClientKeyInfo } from '@/bridge/bridge';

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
  /**
   * Direct access to the BridgeInterface. Use for actions that are pure
   * 1:1 calls to a Bridge method — no rename, no default args, no
   * composition with messageStore / mediaStore. When translation IS
   * needed, route through the named adapters declared below instead.
   */
  bridge: BridgeInterface;

  getLoginInfo: () => { userId: number; nickname: string };
  isOnline: () => boolean;
  getMessage: (messageId: number) => JsonObject | null;
  getMessageMeta: (messageId: number) => MessageMeta | null;
  sendPrivateMessage: (userId: number, message: JsonValue, autoEscape: boolean) => Promise<MessageSendResult>;
  sendGroupMessage: (groupId: number, message: JsonValue, autoEscape: boolean) => Promise<MessageSendResult>;
  deleteMessage: (messageId: number, meta: MessageMeta) => Promise<void>;
  canSendImage: () => boolean;
  canSendRecord: () => boolean;
  // Info retrieval (async — triggers OIDB fetch)
  getFriendList: () => Promise<JsonObject[]>;
  getGroupList: (noCache?: boolean) => Promise<JsonObject[]>;
  getGroupInfo: (groupId: number, noCache?: boolean) => Promise<JsonObject | null>;
  getGroupMemberList: (groupId: number, noCache?: boolean) => Promise<JsonObject[]>;
  getGroupMemberInfo: (groupId: number, userId: number, noCache?: boolean) => Promise<JsonObject | null>;
  getStrangerInfo: (userId: number) => Promise<JsonObject | null>;
  // Group admin (adapters: rename Bridge methods to OneBot vocabulary)
  setGroupKick: (groupId: number, userId: number, rejectAdd: boolean) => Promise<void>;
  setGroupKickMembers: (groupId: number, userIds: number[], rejectAdd: boolean) => Promise<void>;
  setGroupBan: (groupId: number, userId: number, duration: number) => Promise<void>;
  setGroupWholeBan: (groupId: number, enable: boolean) => Promise<void>;
  setGroupLeave: (groupId: number) => Promise<void>;
  // Group file (adapters: field extraction + Bridge name translation)
  uploadGroupFile: (groupId: number, file: string, name?: string, folderId?: string, uploadFile?: boolean) => Promise<string | null>;
  uploadPrivateFile: (userId: number, file: string, name?: string, uploadFile?: boolean) => Promise<string | null>;
  getGroupFileUrl: (groupId: number, fileId: string, busId?: number) => Promise<string>;
  getGroupFiles: (groupId: number, folderId?: string) => Promise<JsonObject>;
  createGroupFileFolder: (groupId: number, name: string, parentId?: string) => Promise<void>;
  getPrivateFileUrl: (userId: number, fileId: string, fileHash: string) => Promise<string>;
  getGroupFileCount: (groupId: number) => Promise<{ fileCount: number; maxCount: number }>;
  // Requests (adapters: rename to OneBot vocabulary)
  handleFriendRequest: (flag: string, approve: boolean) => Promise<void>;
  handleGroupRequest: (flag: string, subType: string, approve: boolean, reason: string) => Promise<void>;
  // Pokes (adapters: flatten isGroup into bridge.sendPoke signature)
  sendFriendPoke: (userId: number, targetId?: number) => Promise<void>;
  sendGroupPoke: (groupId: number, userId: number) => Promise<void>;
  // Essence (adapter: bakes the set/unset boolean)
  setEssenceMsg: (messageId: number) => Promise<void>;
  deleteEssenceMsg: (messageId: number) => Promise<void>;
  // Profile reads with OneBot-specific default args
  getProfileLike: (userId?: number, start?: number, limit?: number) => Promise<any>;
  getGroupEssence: (groupId: number, pageStart?: number, pageLimit?: number) => Promise<GroupEssenceMsgRet>;
  // Friend deletion (adapter: rename + force-boolean)
  handleDeleteFriend: (userId: number, block?: boolean) => Promise<void>;
  // Module wrappers / multi-dep compositions
  getGroupMsgHistory: (groupId: number, messageId?: number, count?: number) => Promise<JsonObject[]>;
  getFriendMsgHistory: (userId: number, messageId?: number, count?: number) => Promise<JsonObject[]>;
  handleGetGroupSystemMsg: () => Promise<JsonObject[]>;
  getDownloadRKeys: () => Promise<JsonObject[]>;
  sendGroupForwardMsg: (groupId: number, messages: JsonValue, meta?: ForwardPreviewMeta) => Promise<{ messageId: number; forwardId: string }>;
  sendPrivateForwardMsg: (userId: number, messages: JsonValue, meta?: ForwardPreviewMeta) => Promise<{ messageId: number; forwardId: string }>;
  sendForwardMsg: (messages: JsonValue) => Promise<{ forwardId: string }>;
  getForwardMsg: (resId: string) => Promise<JsonObject[]>;
  forwardSingleMsg: (messageId: number, target: { groupId?: number; userId?: number }) => Promise<{ messageId: number }>;
  // Extended NapCat-compatible
  setFriendRemark: (userId: number, remark: string) => Promise<void>;
  setGroupRemark: (groupId: number, remark: string) => Promise<void>;
  setGroupAvatar: (groupId: number, source: string) => Promise<void>;
  setMsgEmojiLike: (messageId: number, emojiId: string, set: boolean) => Promise<void>;
  markGroupMsgAsRead: (groupId: number, sequence: number) => Promise<void>;
  markPrivateMsgAsRead: (userId: number, sequence: number) => Promise<void>;
  setOnlineStatus: (status: number, extStatus?: number, batteryStatus?: number) => Promise<void>;
  setProfile: (nickname?: string, personalNote?: string) => Promise<void>;
  fetchCustomFace: (count?: number) => Promise<string[]>;
  getEmojiLikes: (groupId: number, sequence: number, emojiId: string, emojiType?: number, count?: number, cookie?: string) => Promise<{ users: Array<{ uin: number }>, cookie: string, isLast: boolean }>;
  // Web
  getGroupHonorInfo: (groupId: number, type: WebHonorType | string) => Promise<any>;
  getGroupEssenceAll: (groupId: number) => Promise<GroupEssenceMsgRet[]>;
  getGroupAlbumList: (groupId: number) => Promise<any>;
  uploadImageToGroupAlbum: (groupId: number, albumId: string, albumName: string, filePath: string) => Promise<void>;
  getGroupAlbumMediaList: (groupId: number, albumId: string, attachInfo?: string) => Promise<any>;
  commentGroupAlbumMedia: (groupId: number, albumId: string, lloc: string, content: string) => Promise<any>;
  deleteGroupAlbumMedia: (groupId: number, albumId: string, lloc: string) => Promise<any>;
  likeGroupAlbumMedia: (groupId: number, albumId: string, batchId: string, lloc: string | undefined, isLike: boolean) => Promise<any>;
  sendGroupNotice: (groupId: number, content: string, options?: any) => Promise<any>;
  getGroupNotice: (groupId: number) => Promise<any[]>;
  deleteGroupNotice: (groupId: number, fid: string) => Promise<boolean>;
  getCookiesStr: (domain: string) => Promise<string>;
  getCsrfToken: () => Promise<number>;
  getCredentials: (domain: string) => Promise<{ cookies: string; token: number; csrf_token: number }>;
  forceFetchClientKey: () => Promise<ClientKeyInfo>;
  // Media lookup (populated from previously dispatched message segments)
  getImageInfo: (file: string) => Promise<JsonObject | null>;
  getRecordInfo: (file: string) => Promise<JsonObject | null>;
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
    registerGroupAlbum(this, context);
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
