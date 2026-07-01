import { renderParamsVerbose, summarizeParams } from '@snowluma/common/log-summary';
import { createLogger, getLogLevel, nextRequestId, runWithRequestId, type Logger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { ALL_ACTIONS } from './actions';
import { registerActions } from './action-kit';
import type { ForwardPreviewMeta } from './modules/message-actions';
import type { JsonObject, JsonValue, MessageMeta } from './types';
import { RETCODE, failedResponse, okResponse } from './types';
import { type StreamSink, wrapStreamFrame, wrapStreamTerminal } from './streaming';
const moduleLog = createLogger('Bridge.Action');


export interface MessageSendResult {
  messageId: number;
  meta?: MessageMeta;
  echoEvent?: JsonObject;
}

export interface GroupEssenceMsgRet {
  retcode: number;
  data: {
    is_end: boolean;
    msg_list: JsonObject[];
    [key: string]: JsonValue;
  };
  [key: string]: JsonValue;
}

export interface ApiActionContext {
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
  getFriendList: () => Promise<JsonObject[]>;
  getGroupList: (noCache?: boolean) => Promise<JsonObject[]>;
  getGroupInfo: (groupId: number, noCache?: boolean) => Promise<JsonObject | null>;
  getGroupMemberList: (groupId: number, noCache?: boolean) => Promise<JsonObject[]>;
  getGroupMemberInfo: (groupId: number, userId: number, noCache?: boolean) => Promise<JsonObject | null>;
  getStrangerInfo: (userId: number) => Promise<JsonObject | null>;
  getGroupFiles: (groupId: number, folderId?: string) => Promise<JsonObject>;
  handleGroupRequest: (flag: string, subType: string, approve: boolean, reason: string) => Promise<void>;
  setEssenceMsg: (messageId: number) => Promise<void>;
  deleteEssenceMsg: (messageId: number) => Promise<void>;
  getGroupMsgHistory: (groupId: number, messageId?: number, count?: number) => Promise<JsonObject[]>;
  getFriendMsgHistory: (userId: number, messageId?: number, count?: number) => Promise<JsonObject[]>;
  handleGetGroupSystemMsg: () => Promise<JsonObject[]>;
  getDownloadRKeys: () => Promise<JsonObject[]>;
  sendGroupForwardMsg: (groupId: number, messages: JsonValue, meta?: ForwardPreviewMeta) => Promise<{ messageId: number; forwardId: string }>;
  sendPrivateForwardMsg: (userId: number, messages: JsonValue, meta?: ForwardPreviewMeta) => Promise<{ messageId: number; forwardId: string }>;
  sendForwardMsg: (messages: JsonValue, groupId?: number) => Promise<{ forwardId: string }>;
  getForwardMsg: (resId: string) => Promise<JsonObject[]>;
  forwardSingleMsg: (messageId: number, target: { groupId?: number; userId?: number }) => Promise<{ messageId: number }>;
  setMsgEmojiLike: (messageId: number, emojiId: string, set: boolean) => Promise<void>;
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
  getImageInfo: (file: string) => Promise<JsonObject | null>;
  getRecordInfo: (file: string) => Promise<JsonObject | null>;
  fetchPttText: (messageId: number) => Promise<{ text: string }>;
}

type ActionHandler = (params: JsonObject, sink?: StreamSink) => Promise<import('./types').ApiResponse>;

/** A handled-action record handed to debug observers. */
export interface ActionRecord {
  action: string;
  params: JsonObject;
  response: import('./types').ApiResponse;
  ms: number;
}
export type ActionObserver = (rec: ActionRecord) => void;

export class ApiHandler {
  private readonly handlers = new Map<string, ActionHandler>();
  /** Names that answer with a multi-frame Stream API response (#163). The
   *  network adapter consults this BEFORE dispatch to pick streaming output. */
  private readonly streamActions = new Set<string>();
  private readonly log: Logger;
  /** Debug-stream taps — notified after every handled action. Attached
   *  on-demand (ref-counted) by the WebUI debug stream. */
  private readonly observers = new Set<ActionObserver>();

  /** Observe handled actions (debug). Returns an unsubscribe. */
  setObserver(cb: ActionObserver): () => void {
    this.observers.add(cb);
    return () => { this.observers.delete(cb); };
  }

  constructor(context: ApiActionContext, uin?: number) {
    this.log = typeof uin === 'number' && uin > 0 ? moduleLog.child({ uin }) : moduleLog;
    registerActions(this, context, ALL_ACTIONS);

    // The one non-ActionSpec handler: `.handle_quick_operation` needs the
    // ApiHandler itself (to re-drive actions via executeQuickOperation), which
    // ActionSpec.run's (params, ctx) signature can't supply — so it's the sole
    // raw registration, kept here rather than in an action file's footer.
    this.registerAction('.handle_quick_operation', async (params) => {
      const opContext = params.context as JsonObject | undefined;
      const operation = params.operation as Record<string, unknown> | undefined;
      if (!opContext || !operation) return failedResponse(RETCODE.BAD_REQUEST, 'context and operation are required');
      const { executeQuickOperation } = await import('./network/quick-operation');
      await executeQuickOperation(opContext, operation, this);
      return okResponse();
    });
  }

  registerAction(action: string, handler: ActionHandler): void {
    this.handlers.set(action, handler);
  }

  /** Register a Stream API action — dispatched exactly like a normal action,
   *  but flagged so adapters stream its frames (the handler receives a sink). */
  registerStreamAction(action: string, handler: ActionHandler): void {
    this.handlers.set(action, handler);
    this.streamActions.add(action);
  }

  /** Whether `action` answers with a multi-frame Stream API response. */
  isStreamAction(action: string): boolean {
    return this.streamActions.has(action);
  }

  async handle(action: string, params: JsonObject, sink?: StreamSink): Promise<import('./types').ApiResponse> {
    const handler = this.handlers.get(action);
    if (!handler) {
      this.log.debug('unknown action %s', action);
      return failedResponse(RETCODE.UNKNOWN_ACTION, 'unknown action');
    }

    // Correlate the whole request — entry, every outbound packet it triggers,
    // and the exit — under one `[req#N]` tag via AsyncLocalStorage. Only pay
    // the wrap + id allocation when trace is actually live, so the default
    // path stays allocation-free.
    if (getLogLevel() !== 'trace') {
      return this.runAction(action, handler, params, sink);
    }
    return runWithRequestId(nextRequestId(), () => this.runAction(action, handler, params, sink));
  }

  private async runAction(
    action: string,
    handler: ActionHandler,
    params: JsonObject,
    sink?: StreamSink,
  ): Promise<import('./types').ApiResponse> {
    // Terse breadcrumb to the log file (debug, always persisted): lets the
    // operator grep "what did the bot get asked to do" in post-mortems.
    this.log.debug('%s params=%s', action, summarizeParams(params));
    // Full request shape, memory-only (trace). Lazy producer → the deep render
    // only runs when trace is live.
    this.log.trace(() => [`${action} ⇐ %s`, renderParamsVerbose(params)]);

    const startedAt = Date.now();
    let response: import('./types').ApiResponse;
    try {
      response = await handler(params, sink);
      this.log.trace(() => [`${action} ⇒ ${response.status} (${Date.now() - startedAt}ms)`]);
    } catch (error) {
      // Single error seam: any throw from a handler (bridge/OIDB business
      // failure or an unexpected internal fault) maps here to one policy —
      // ACTION_FAILED (100) + the error's message. Action `run` bodies
      // shouldn't need to hand-roll their own try/catch → failedResponse:
      // doing so only produced inconsistent retcodes (100 vs 1200) for the same
      // kind of failure. The remaining per-action catches (qzone / group-album,
      // still returning 1200) are being removed in a follow-up phase — until
      // then their failures never reach this seam. `OidbError.message` already
      // carries the QQ server code, so no special-casing is needed. warn (not
      // error) keeps the log file a useful signal without drowning it in
      // expected client-side failures.
      this.log.warn('%s failed: %s\n%s',
        action,
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? (error.stack ?? '') : '');
      const message = error instanceof Error ? error.message : String(error);
      response = failedResponse(RETCODE.ACTION_FAILED, message);
    }
    this.notifyObservers(action, params, response, Date.now() - startedAt);
    return response;
  }

  private notifyObservers(
    action: string,
    params: JsonObject,
    response: import('./types').ApiResponse,
    ms: number,
  ): void {
    if (!this.observers.size) return;
    for (const cb of this.observers) {
      try { cb({ action, params, response, ms }); } catch (err) {
        this.log.warn('action observer error: %s', err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** WS dispatch supporting Stream API multi-frame responses. A normal action
   *  emits exactly one frame; a stream action emits each intermediate frame
   *  then the terminal frame — every frame carries the request's echo. `emit`
   *  writes one JSON string per frame; awaiting it lets the transport apply
   *  backpressure. `isAlive`, when supplied, is checked before each stream
   *  frame — returning false aborts the action (e.g. the client disconnected),
   *  so a dead client can't make a download keep pumping frames into the void. */
  async processStreamRequest(
    rawRequest: string,
    emit: (json: string) => void | Promise<void>,
    isAlive?: () => boolean,
  ): Promise<void> {
    const bad = (): void => { void emit(JSON.stringify(failedResponse(RETCODE.BAD_REQUEST, 'bad request'))); };
    if (!rawRequest.trim()) { bad(); return; }

    let action: string;
    let params: JsonObject;
    let echo: JsonValue | undefined;
    try {
      const parsed = JSON.parse(rawRequest) as unknown;
      if (!isJsonObject(parsed)) { bad(); return; }
      const a = asString(parsed.action);
      if (!a) { bad(); return; }
      action = a;
      params = isJsonObject(parsed.params) ? parsed.params : {};
      echo = parsed.echo !== undefined ? toJsonValue(parsed.echo) : undefined;
    } catch {
      bad();
      return;
    }

    if (!this.isStreamAction(action)) {
      const response = await this.handle(action, params);
      if (echo !== undefined) response.echo = echo;
      await emit(JSON.stringify(response));
      return;
    }

    const sink: StreamSink = {
      send: async (frame) => {
        if (isAlive && !isAlive()) throw new Error('stream transport closed');
        await emit(JSON.stringify(wrapStreamFrame(frame, echo)));
      },
    };
    const response = await this.handle(action, params, sink);
    await emit(JSON.stringify(wrapStreamTerminal(response, echo)));
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
