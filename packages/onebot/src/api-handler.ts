import { renderParamsVerbose, summarizeParams } from '@snowluma/common/log-summary';
import { createLogger, runWithTraceRequest, type Logger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { MessageElementValidationError } from '@snowluma/protocol/element-manifest';
import {
  ACTION_REGISTRY,
  HANDLE_QUICK_OPERATION_ACTION,
  type CompiledActionKind,
  type CompiledActionRegistry,
} from './actions';
import type { GroupSystemMessageQuery } from './modules/contact-actions';
import type { ForwardPreviewMeta } from './modules/message-actions';
import type { ReadSessionTargets } from './message-store';
import type { JsonObject, JsonValue, MessageMeta } from './types';
import { RETCODE, failedResponse, okResponse } from './types';
import {
  StreamTransportClosedError,
  type StreamSink,
  wrapStreamFrame,
  wrapStreamTerminal,
} from './streaming';
const moduleLog = createLogger('Bridge.Action');

function summarizeActionParams(action: string, params: JsonObject): string {
  if (action !== 'fetch_emoji_like') return summarizeParams(params);

  const safeParams: JsonObject = { ...params };
  const cursor = params.cookie;
  if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) {
    return summarizeParams(safeParams);
  }

  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) return summarizeParams(safeParams);

  delete safeParams.cookie;
  safeParams.emoji_like_offset = offset;
  return summarizeParams(safeParams);
}


export interface MessageSendResult {
  messageId: number;
  meta?: MessageMeta;
  echoEvent?: JsonObject;
}

export interface ApiActionContext {
  bridge: BridgeInterface;
  getLoginInfo: () => { userId: number; nickname: string };
  isOnline: () => boolean;
  getMessage: (messageId: number) => JsonObject | null;
  getMessageMeta: (messageId: number) => MessageMeta | null;
  cacheMessageMetas: (
    entries: ReadonlyArray<{ messageId: number; meta: MessageMeta }>,
  ) => void;
  listReadSessions: () => ReadSessionTargets;
  sendPrivateMessage: (userId: number, message: JsonValue, autoEscape: boolean, tempGroupId?: number) => Promise<MessageSendResult>;
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
  getGroupMsgHistory: (groupId: number, messageId?: number, count?: number, reverseOrder?: boolean) => Promise<JsonObject[]>;
  getFriendMsgHistory: (userId: number, messageId?: number, count?: number, reverseOrder?: boolean) => Promise<JsonObject[]>;
  handleGetGroupSystemMsg: (query: GroupSystemMessageQuery) => Promise<JsonObject[]>;
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

interface RegisteredHandler {
  readonly handler: ActionHandler;
  readonly canonical: string;
  readonly kind: CompiledActionKind;
}

/** A handled-action record handed to debug observers. */
export interface ActionRecord {
  action: string;
  params: JsonObject;
  response: import('./types').ApiResponse;
  ms: number;
}
export type ActionObserver = (rec: ActionRecord) => void;

export class ApiHandler {
  /** Handler + dispatch kind live in one record so stream classification can
   *  never outlive or drift from the handler it describes. */
  private readonly handlers = new Map<string, RegisteredHandler>();
  private readonly registry: CompiledActionRegistry;
  private registrationOpen = true;
  /** Sticky instance-lifecycle gate. A failed transport close may restore its
   *  own listener for retry, but it must never reopen execution against a
   *  retiring Bridge/store generation. */
  private acceptingActions = true;
  private readonly log: Logger;
  /** Debug-stream taps — notified after every handled action. Attached
   *  on-demand (ref-counted) by the WebUI debug stream. */
  private readonly observers = new Set<ActionObserver>();

  /** Observe handled actions (debug). Returns an unsubscribe. */
  setObserver(cb: ActionObserver): () => void {
    this.observers.add(cb);
    return () => { this.observers.delete(cb); };
  }

  constructor(
    context: ApiActionContext,
    uin?: number,
    registry: CompiledActionRegistry = ACTION_REGISTRY,
  ) {
    this.registry = registry;
    this.log = typeof uin === 'number' && uin > 0 ? moduleLog.child({ uin }) : moduleLog;
    try {
      registry.register(this, context);

      // The one non-ActionSpec handler: `.handle_quick_operation` needs the
      // ApiHandler itself (to re-drive actions via executeQuickOperation), which
      // ActionSpec.run's (params, ctx) signature can't supply — so it's the sole
      // raw registration, kept here rather than in an action file's footer.
      this.registerRawAction(HANDLE_QUICK_OPERATION_ACTION, async (params) => {
        const opContext = params.context as JsonObject | undefined;
        const operation = params.operation as Record<string, unknown> | undefined;
        if (!opContext || !operation) return failedResponse(RETCODE.BAD_REQUEST, 'context and operation are required');
        const { executeQuickOperation } = await import('./network/quick-operation');
        await executeQuickOperation(opContext, operation, this);
        return okResponse();
      });
      this.assertRegistryFullyBound();
    } finally {
      // registerAction/registerStreamAction are the constructor-time port used
      // by ActionSpec. Once construction finishes (successfully or not), the
      // runtime namespace is immutable and cannot bypass the compiled registry.
      this.registrationOpen = false;
    }
  }

  registerAction(action: string, handler: ActionHandler): void {
    this.registerHandler(action, handler, 'normal');
  }

  /** Register a Stream API action — dispatched exactly like a normal action,
   *  but flagged so adapters stream its frames (the handler receives a sink). */
  registerStreamAction(action: string, handler: ActionHandler): void {
    this.registerHandler(action, handler, 'stream');
  }

  private registerRawAction(action: string, handler: ActionHandler): void {
    this.registerHandler(action, handler, 'raw');
  }

  private registerHandler(action: string, handler: ActionHandler, kind: CompiledActionKind): void {
    if (!this.registrationOpen) {
      throw new Error(
        `Action registry is sealed; cannot register canonical "${action}" (name "${action}", kind ${kind})`,
      );
    }
    const claim = this.registry.resolve(action);
    if (!claim) {
      throw new Error(
        `Action registration is not declared by the compiled registry: `
        + `canonical "${action}" (name "${action}", kind ${kind})`,
      );
    }
    const canonical = claim.canonical;
    const existing = this.handlers.get(action);
    if (existing) {
      throw new Error(
        `Action handler conflict for executable name "${action}": `
        + `canonical "${existing.canonical}" (name "${action}", kind ${existing.kind}) conflicts with `
        + `canonical "${canonical}" (name "${action}", kind ${kind})`,
      );
    }
    if (claim.kind !== kind) {
      throw new Error(
        `Action handler kind mismatch for canonical "${canonical}" (name "${action}"): `
        + `registry kind ${claim.kind}, registration kind ${kind}`,
      );
    }
    this.handlers.set(action, { handler, canonical, kind });
  }

  private assertRegistryFullyBound(): void {
    for (const claim of this.registry.executableNames) {
      if (this.handlers.has(claim.name)) continue;
      throw new Error(
        `Action registry claim has no handler: canonical "${claim.canonical}" `
        + `(name "${claim.name}", kind ${claim.kind})`,
      );
    }
    if (this.handlers.size !== this.registry.executableNames.length) {
      throw new Error(
        `Action registry binding count mismatch: ${this.handlers.size} handlers for `
        + `${this.registry.executableNames.length} executable names`,
      );
    }
  }

  /** Whether `action` answers with a multi-frame Stream API response. */
  isStreamAction(action: string): boolean {
    return this.handlers.get(action)?.kind === 'stream';
  }

  /** Whether the owning OneBot instance still accepts new Action execution. */
  get isAcceptingActions(): boolean {
    return this.acceptingActions;
  }

  /** Permanently reject new Actions for this handler generation.
   *
   * Existing calls have already been admitted and are drained by their owning
   * transport/instance. There is intentionally no resume operation: hot reload
   * keeps the same live generation open, while teardown creates a new handler
   * only after the previous generation has fully retired. */
  quiesce(): void {
    if (!this.acceptingActions) return;
    this.acceptingActions = false;
    this.log.info('Action ingress quiesced');
  }

  async handle(action: string, params: JsonObject, sink?: StreamSink): Promise<import('./types').ApiResponse> {
    return runWithTraceRequest(() => this.handleInContext(action, params, sink));
  }

  traceQuiescedAction(
    action: string,
    params: JsonObject,
    response: import('./types').ApiResponse,
  ): void {
    if (this.acceptingActions) return;
    runWithTraceRequest(() => {
      const startedAt = Date.now();
      this.traceActionInput(action, params);
      this.traceActionTerminal(action, response, startedAt, 'failed', 'quiesced');
    });
  }

  traceQuiescedStreamRequest(rawRequest: string): void {
    const request = parseStreamRequest(rawRequest);
    if (!request) return;
    this.traceQuiescedAction(
      request.action,
      request.params,
      failedResponse(RETCODE.ACTION_FAILED, 'OneBot instance is shutting down'),
    );
  }

  private async handleInContext(
    action: string,
    params: JsonObject,
    sink?: StreamSink,
  ): Promise<import('./types').ApiResponse> {
    const startedAt = Date.now();
    this.traceActionInput(action, params);

    if (!this.acceptingActions) {
      const response = failedResponse(RETCODE.ACTION_FAILED, 'OneBot instance is shutting down');
      this.log.warn('rejected Action %s after instance quiesce', action);
      this.traceActionTerminal(action, response, startedAt, 'failed', 'quiesced');
      this.notifyObservers(action, params, response, 0);
      return response;
    }

    const registered = this.handlers.get(action);
    if (!registered) {
      const response = failedResponse(RETCODE.UNKNOWN_ACTION, 'unknown action');
      this.log.debug('unknown action %s', action);
      this.traceActionTerminal(action, response, startedAt, 'failed', 'unknown_action');
      return response;
    }

    return this.runAction(action, registered.handler, params, sink, startedAt);
  }

  private async runAction(
    action: string,
    handler: ActionHandler,
    params: JsonObject,
    sink: StreamSink | undefined,
    startedAt: number,
  ): Promise<import('./types').ApiResponse> {
    // Terse breadcrumb to the log file (debug, which is written to disk under the default
    // file level): lets the operator grep "what did the bot get asked to do" in post-mortems.
    this.log.debug('%s params=%s', action, summarizeActionParams(action, params));

    let response: import('./types').ApiResponse;
    let outcome: 'ok' | 'failed' | 'cancelled';
    let reason: 'response_returned' | 'handler_threw' | 'transport_closed';
    try {
      response = await handler(
        params,
        sink
          ? {
            send: async (frame) => {
              this.log.trace(() => [
                'action_stream_frame action=%s frame=%s',
                action,
                renderParamsVerbose(frame),
              ]);
              await sink.send(frame);
            },
          }
          : undefined,
      );
      outcome = response.status === 'ok' ? 'ok' : 'failed';
      reason = 'response_returned';
    } catch (error) {
      // Single error seam: typed message-contract failures are caller errors
      // and therefore map to BAD_REQUEST. Bridge/OIDB business failures and
      // unexpected internal faults retain the shared ACTION_FAILED policy.
      // Action `run` bodies should not hand-roll their own catch/response
      // mapping: central classification keeps every transport consistent.
      // `OidbError.message` already carries the QQ server code, so it needs no
      // special casing. warn (not error) keeps the log file useful without
      // drowning it in expected client-side failures.
      this.log.warn('%s failed: %s\n%s',
        action,
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? (error.stack ?? '') : '');
      const message = error instanceof Error ? error.message : String(error);
      const retcode = error instanceof MessageElementValidationError
        ? RETCODE.BAD_REQUEST
        : RETCODE.ACTION_FAILED;
      response = failedResponse(retcode, message);
      outcome = error instanceof StreamTransportClosedError ? 'cancelled' : 'failed';
      reason = error instanceof StreamTransportClosedError ? 'transport_closed' : 'handler_threw';
    }
    this.traceActionTerminal(action, response, startedAt, outcome, reason);
    this.notifyObservers(action, params, response, Date.now() - startedAt);
    return response;
  }

  private traceActionInput(
    action: string,
    params: JsonObject,
  ): void {
    this.log.trace(() => [
      'action_input action=%s params=%s',
      action,
      renderParamsVerbose(params),
    ]);
  }

  private traceActionTerminal(
    action: string,
    response: import('./types').ApiResponse,
    startedAt: number,
    outcome: 'ok' | 'failed' | 'cancelled',
    reason: 'response_returned' | 'handler_threw' | 'transport_closed' | 'unknown_action' | 'quiesced',
  ): void {
    this.log.trace(() => [
      'action_terminal action=%s outcome=%s reason=%s ms=%d response=%s',
      action,
      outcome,
      reason,
      Date.now() - startedAt,
      renderParamsVerbose(response),
    ]);
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
    const bad = (): Promise<void> => Promise.resolve(
      emit(JSON.stringify(failedResponse(RETCODE.BAD_REQUEST, 'bad request'))),
    );
    if (!rawRequest.trim()) { await bad(); return; }

    const request = parseStreamRequest(rawRequest);
    if (!request) { await bad(); return; }
    const { action, params, echo } = request;

    if (!this.isStreamAction(action)) {
      const response = await this.handle(action, params);
      if (echo !== undefined) response.echo = echo;
      await emit(JSON.stringify(response));
      return;
    }

    const sink: StreamSink = {
      send: async (frame) => {
        if (isAlive && !isAlive()) throw new StreamTransportClosedError();
        await emit(JSON.stringify(wrapStreamFrame(frame, echo)));
      },
    };
    const response = await this.handle(action, params, sink);
    await emit(JSON.stringify(wrapStreamTerminal(response, echo)));
  }
}

interface StreamRequest {
  action: string;
  params: JsonObject;
  echo: JsonValue | undefined;
}

function parseStreamRequest(rawRequest: string): StreamRequest | null {
  if (!rawRequest.trim()) return null;
  try {
    const parsed = JSON.parse(rawRequest) as unknown;
    if (!isJsonObject(parsed)) return null;
    const action = asString(parsed.action);
    if (!action) return null;
    return {
      action,
      params: isJsonObject(parsed.params) ? parsed.params : {},
      echo: parsed.echo !== undefined ? toJsonValue(parsed.echo) : undefined,
    };
  } catch {
    return null;
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
