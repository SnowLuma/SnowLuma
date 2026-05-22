import type { JsonObject, JsonValue, MessageMeta } from './types';
import type { ForwardPreviewMeta } from './modules/message-actions';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { RETCODE, failedResponse } from './types';
import { createLogger, type Logger } from '@snowluma/common/logger';
import { summarizeParams } from '@snowluma/common/log-summary';

const moduleLog = createLogger('Bridge.Action');

import { register as registerInfo } from './actions/info';
import { register as registerMessage } from './actions/message';
import { register as registerFriend } from './actions/friend';
import { register as registerGroupInfo } from './actions/group-info';
import { register as registerGroupAdmin } from './actions/group-admin';
import { register as registerGroupFile } from './actions/group-file';
import { register as registerRequest } from './actions/request';
import { register as registerExtended } from './actions/extended';
import { register as registerGroupAlbum } from './actions/group-album';

import { WebHonorType } from '@snowluma/bridge/web/group-honor';
import type { ClientKeyInfo } from '@snowluma/core/bridge';

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
  // Group admin (mute/kick/admin/card/name/title/leave/etc) — all
  // accessed directly through `ctx.bridge.apis.groupAdmin.method()`
  // after the #6 OneBot-side slim-down; no per-method passthrough
  // here anymore.
  // Group file passthroughs are gone — actions call
  // `ctx.bridge.apis.groupFile.{upload,uploadPrivate,getUrl,
  // createFolder,getPrivateUrl,getCount}` directly. `getGroupFiles`
  // stays because it composes through the `getGroupFiles` module
  // helper (identity-lookup enrichment of uploader names).
  getGroupFiles: (groupId: number, folderId?: string) => Promise<JsonObject>;
  // Friend requests: direct via `ctx.bridge.apis.friend.handleRequest`.
  // Group requests: stay on ctx because `handleGroupAddRequest` is a
  // module helper that does the flag-parsing + group-request lookup
  // dance before routing to `bridge.apis.groupAdmin.setAddRequest`.
  handleGroupRequest: (flag: string, subType: string, approve: boolean, reason: string) => Promise<void>;
  // Pokes: direct via `ctx.bridge.apis.interaction.sendPoke(isGroup, …)`.
  // Essence (adapter: bakes the set/unset boolean)
  setEssenceMsg: (messageId: number) => Promise<void>;
  deleteEssenceMsg: (messageId: number) => Promise<void>;
  // Profile reads and group essence reads: direct via
  // `ctx.bridge.apis.profile.getLike(...)` and
  // `ctx.bridge.apis.web.getEssence(...)`.
  // Friend deletion: direct via `ctx.bridge.apis.friend.delete(userId, block)`.
  // Module wrappers / multi-dep compositions
  getGroupMsgHistory: (groupId: number, messageId?: number, count?: number) => Promise<JsonObject[]>;
  getFriendMsgHistory: (userId: number, messageId?: number, count?: number) => Promise<JsonObject[]>;
  handleGetGroupSystemMsg: () => Promise<JsonObject[]>;
  getDownloadRKeys: () => Promise<JsonObject[]>;
  sendGroupForwardMsg: (groupId: number, messages: JsonValue, meta?: ForwardPreviewMeta) => Promise<{ messageId: number; forwardId: string }>;
  sendPrivateForwardMsg: (userId: number, messages: JsonValue, meta?: ForwardPreviewMeta) => Promise<{ messageId: number; forwardId: string }>;
  sendForwardMsg: (messages: JsonValue, groupId?: number) => Promise<{ forwardId: string }>;
  getForwardMsg: (resId: string) => Promise<JsonObject[]>;
  forwardSingleMsg: (messageId: number, target: { groupId?: number; userId?: number }) => Promise<{ messageId: number }>;
  // setMsgEmojiLike: stays because it threads messageStore meta lookup.
  setMsgEmojiLike: (messageId: number, emojiId: string, set: boolean) => Promise<void>;
  /**
   * Fetch the cached reactor user list for a (message, emoji) pair.
   * Backed by ReactionStore — see `reaction-store.ts` for the
   * limitations vs. NapCat's wrapper-cache approach.
   *
   * `serverCount` comes from a side `0x9084_1` summary call; when it
   * exceeds `cachedUsers.length` the cache is provably incomplete
   * (push events missed before bot boot, etc).
   */
  fetchEmojiLikeUsers: (
    messageId: number,
    emojiId: string,
    count: number,
    offset?: number,
  ) => Promise<{
    users: Array<{ uin: number; uid: string; setAt: number }>;
    cachedCount: number;
    serverCount: number;
    complete: boolean;
  }>;
  // All other extended / NapCat-compatible / Web / Album actions are
  // accessed directly through `ctx.bridge.apis.<area>.<method>()`:
  //   * profile area:    setProfile / setOnlineStatus / fetchCustomFace /
  //                      setGroupAvatar / getLike
  //   * friend area:     setRemark / delete / handleRequest
  //   * web area:        getHonorInfo / getEssence(All) / sendNotice /
  //                      getNotice / deleteNotice / getCookiesStr /
  //                      getCsrfToken / getCredentials / forceFetchClientKey
  //   * groupAlbum area: list / upload / getMediaList / comment /
  //                      delete / like
  // Media lookup (populated from previously dispatched message segments)
  getImageInfo: (file: string) => Promise<JsonObject | null>;
  getRecordInfo: (file: string) => Promise<JsonObject | null>;
}

type ActionHandler = (params: JsonObject) => Promise<import('./types').ApiResponse>;

export class ApiHandler {
  private readonly handlers = new Map<string, ActionHandler>();
  private readonly log: Logger;

  constructor(context: ApiActionContext, uin?: number) {
    this.log = typeof uin === 'number' && uin > 0 ? moduleLog.child({ uin }) : moduleLog;
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
      this.log.debug('unknown action %s', action);
      return failedResponse(RETCODE.UNKNOWN_ACTION, 'unknown action');
    }

    // Entry log goes to file always (debug); console only when level is
    // dialed down to debug. Caller-perspective summary lets the operator
    // grep "what did the bot get asked to do" without scraping wire logs.
    this.log.debug('%s params=%s', action, summarizeParams(params));

    try {
      return await handler(params);
    } catch (error) {
      // Action failures are almost always param-shape problems coming
      // from the OneBot client; warn (not error) is the right level so
      // the log file stays a useful signal of real internal faults.
      this.log.warn('%s failed: %s\n%s',
        action,
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? (error.stack ?? '') : '');
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
