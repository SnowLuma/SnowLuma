import { createLogger, runWithTraceRequest, type Logger } from '@snowluma/common/logger';
import { renderParamsVerbose } from '@snowluma/common/log-summary';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { CONVERTERS, convertEvent } from './event-converter';
import type { OneBotInstanceContext } from './instance-context';
import {
  GROUP_MESSAGE_EVENT,
  PRIVATE_MESSAGE_EVENT,
  hashMessageIdInt32,
  privateMessageEventName,
} from './message-id';
import { backfillReplyTarget } from './modules/message-actions';
import { deliverPttTransText, pttTransKey } from './modules/ptt-trans-waiter';
import type { MessageMeta } from './types';

const moduleLog = createLogger('Event');

/** Lifecycle handle for the asynchronous bridge-event pipeline.
 *
 * `stop()` is synchronous and idempotent: it removes every subscription so no
 * new conversion can start. `drain()` resolves only after conversions that had
 * already started have settled. Instance teardown must call them in that order
 * before closing stores used by conversion/backfill/dispatch. */
export interface EventPipelineHandle {
  stop(): void;
  drain(): Promise<void>;
}

export function registerEventPipeline(ctx: OneBotInstanceContext): EventPipelineHandle {
  const uinNum = Number.parseInt(ctx.uin, 10);
  const log = Number.isFinite(uinNum) && uinNum > 0 ? moduleLog.child({ uin: uinNum }) : moduleLog;
  const disposers: Array<() => void> = [];
  const inFlight = new Set<Promise<void>>();
  let accepting = true;

  const track = (
    event: QQEventVariant,
    start: (state: EventTraceState) => void | Promise<void>,
  ): Promise<void> => {
    if (!accepting) return Promise.resolve();
    return runWithTraceRequest(() => {
      const state: EventTraceState = {
        startedAt: Date.now(),
        handedOff: false,
        terminalEmitted: false,
      };
      log.trace(() => [
        'event_input kind=%s event=%s',
        event.kind,
        renderParamsVerbose(event),
      ]);

      let operation: Promise<void>;
      try {
        operation = Promise.resolve(start(state));
      } catch (error) {
        operation = Promise.reject(error);
      }
      const tracked = operation.then(
        () => undefined,
        (error) => {
          if (!state.handedOff && !state.terminalEmitted) {
            traceEventTerminal(log, event.kind, state, 'failed', 'pipeline_threw', error);
          }
          log.error(
            'event pipeline handler failed kind=%s: %s',
            event.kind,
            error instanceof Error ? (error.stack ?? error.message) : String(error),
          );
        },
      );
      inFlight.add(tracked);
      void tracked.then(() => { inFlight.delete(tracked); });
      return tracked;
    });
  };

  for (const kind of Object.keys(EVENT_PIPELINE) as EventKind[]) {
    const entry = EVENT_PIPELINE[kind];
    if ('drop' in entry) continue;
    const handle = entry.handle as PipelineHandler<EventKind>;
    disposers.push(
      ctx.bridge.events.on(kind, (event) => track(event, (state) => handle(ctx, log, event, state))),
    );
  }

  const stop = (): void => {
    if (!accepting) return;
    accepting = false;
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        log.error(
          'event pipeline unsubscribe failed: %s',
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        );
      }
    }
  };

  return {
    stop,
    async drain(): Promise<void> {
      // `stop()` makes the set monotonic: no later event can be admitted while
      // this snapshot is settling.
      if (accepting) {
        throw new Error('event pipeline must be stopped before it can be drained');
      }
      await Promise.allSettled([...inFlight]);
    },
  };
}

type EventKind = QQEventVariant['kind'];

type PipelineHandler<K extends EventKind> = (
  ctx: OneBotInstanceContext,
  log: Logger,
  event: Extract<QQEventVariant, { kind: K }>,
  state: EventTraceState,
) => void | Promise<void>;

type PipelineDisposition<K extends EventKind> =
  | { readonly handle: PipelineHandler<K> }
  | { readonly drop: true };

type PipelineRegistry = { [K in EventKind]: PipelineDisposition<K> };

interface EventTraceState {
  startedAt: number;
  handedOff: boolean;
  terminalEmitted: boolean;
}

type PipelineEventOutcome = 'dropped' | 'failed' | 'internal';
type PipelineEventReason =
  | 'converter_returned_null'
  | 'converter_threw'
  | 'pipeline_threw'
  | 'recalled_before_backfill'
  | 'recalled_after_backfill'
  | 'waiter_notified';

async function convertAndDispatch(
  ctx: OneBotInstanceContext,
  log: Logger,
  event: QQEventVariant,
  state: EventTraceState,
  messageIdOverride?: number,
): Promise<void> {
  let converted;
  try {
    converted = await convertEvent(ctx.converterCtx, event);
  } catch (error) {
    traceEventTerminal(log, event.kind, state, 'failed', 'converter_threw', error);
    throw error;
  }

  if (!converted) {
    traceEventTerminal(log, event.kind, state, 'dropped', 'converter_returned_null');
    return;
  }
  if (messageIdOverride !== undefined && event.kind === 'friend_recall') {
    converted.message_id = messageIdOverride;
  }
  log.trace(() => [
    'event_converted kind=%s event=%s',
    event.kind,
    renderParamsVerbose(converted),
  ]);

  if (event.kind === 'friend_message' && isFriendMessageRecalled(ctx, log, event)) {
    traceEventTerminal(log, event.kind, state, 'dropped', 'recalled_before_backfill');
    return;
  }
  // If this message quotes one we don't have, fetch + persist it first (gated +
  // throttled) so a consumer's get_msg on the quote resolves. No-op for the
  // common case (no reply, or the quoted message is already stored). Never let a
  // back-fill failure block delivery of the live message.
  try {
    await backfillReplyTarget(ctx, event);
  } catch (error) {
    // Best-effort — dispatch the live event regardless, but keep the failure
    // attributable so a repeated store/server miss is diagnosable.
    log.warn(
      'reply backfill failed kind=%s: %s',
      event.kind,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    log.trace(() => [
      'event_branch kind=%s reason=reply_backfill_failed error=%s',
      event.kind,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ]);
  }
  // Backfill can await several network/media operations. Re-check immediately
  // before dispatch so a recall that arrived during that gap wins the race.
  if (event.kind === 'friend_message' && isFriendMessageRecalled(ctx, log, event)) {
    traceEventTerminal(log, event.kind, state, 'dropped', 'recalled_after_backfill');
    return;
  }

  ctx.dispatchEvent(converted, 'bridge', state.startedAt);
  state.handedOff = true;
}

function traceEventTerminal(
  log: Logger,
  kind: QQEventVariant['kind'],
  state: EventTraceState,
  outcome: PipelineEventOutcome,
  reason: PipelineEventReason,
  error?: unknown,
): void {
  if (state.terminalEmitted) return;
  state.terminalEmitted = true;
  log.trace(() => [
    'event_terminal kind=%s outcome=%s reason=%s ms=%d%s',
    kind,
    outcome,
    reason,
    Date.now() - state.startedAt,
    error === undefined
      ? ''
      : ` error=${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  ]);
}

function cacheGroupMessageMeta(ctx: OneBotInstanceContext, event: Extract<QQEventVariant, { kind: 'group_message' }>): void {
  const messageId = hashMessageIdInt32(event.msgSeq, event.groupId, GROUP_MESSAGE_EVENT);
  ctx.cacheMessageMeta(messageId, {
    isGroup: true,
    targetId: event.groupId,
    sequence: event.msgSeq,
    sequenceAuthoritative: true,
    eventName: GROUP_MESSAGE_EVENT,
    clientSequence: 0,
    random: event.msgId,
    timestamp: event.time,
  });
}

function cachePrivateMessageMeta(
  ctx: OneBotInstanceContext,
  sessionId: number,
  messageSequence: number,
  serverSequence: number,
  clientSequence: number,
  timestamp: number,
  random: number,
  sequenceAuthoritative: boolean,
  privateDirection: MessageMeta['privateDirection'],
): void {
  const isFriendMessage = privateDirection !== undefined;
  const hasNtSequence = isFriendMessage
    && sequenceAuthoritative
    && serverSequence > 0;
  const eventName = isFriendMessage
    ? privateMessageEventName(privateDirection === 'outgoing', hasNtSequence)
    : PRIVATE_MESSAGE_EVENT;
  const messageId = hashMessageIdInt32(
    hasNtSequence ? serverSequence : messageSequence,
    sessionId,
    eventName,
  );
  ctx.cacheMessageMeta(messageId, {
    isGroup: false,
    targetId: sessionId,
    sequence: serverSequence,
    sequenceAuthoritative: sequenceAuthoritative && serverSequence > 0,
    eventName,
    clientSequence,
    privateDirection,
    random,
    timestamp,
  });
}

function isFriendMessageRecalled(
  ctx: OneBotInstanceContext,
  log: Logger,
  event: Extract<QQEventVariant, { kind: 'friend_message' }>,
): boolean {
  const peerUin = event.peerUin ?? event.senderUin;
  const clientSequence = event.clientSeq ?? event.msgSeq;
  const sentBySelf = event.senderUin === ctx.selfId;
  const recalled = ctx.messageStore.isPrivateMessageRecalled(
    peerUin,
    clientSequence,
    sentBySelf,
    event.time,
  );
  if (recalled) {
    log.debug(
      'friend message suppressed by recall tombstone peer=%d clientSeq=%d self=%s',
      peerUin,
      clientSequence,
      String(sentBySelf),
    );
  }
  return recalled;
}

function cacheReaction(
  ctx: OneBotInstanceContext,
  event: Extract<QQEventVariant, { kind: 'group_msg_emoji_like' }>,
): void {
  if (!event.groupId || !event.msgSeq || !event.emojiId || !event.operatorUin) return;
  if (event.isAdd) {
    ctx.reactionStore.recordAdd(
      event.groupId,
      event.msgSeq,
      event.emojiId,
      1,
      event.operatorUin,
      event.operatorUid,
      event.time,
    );
  } else {
    ctx.reactionStore.recordRemove(
      event.groupId,
      event.msgSeq,
      event.emojiId,
      event.operatorUin,
    );
  }
}

function handleGroupMessage(
  ctx: OneBotInstanceContext,
  log: Logger,
  event: Extract<QQEventVariant, { kind: 'group_message' }>,
  state: EventTraceState,
): Promise<void> {
  cacheGroupMessageMeta(ctx, event);
  return convertAndDispatch(ctx, log, event, state);
}

function handleFriendMessage(
  ctx: OneBotInstanceContext,
  log: Logger,
  event: Extract<QQEventVariant, { kind: 'friend_message' }>,
  state: EventTraceState,
): Promise<void> {
  cachePrivateMessageMeta(
    ctx,
    event.peerUin ?? event.senderUin,
    event.msgSeq,
    event.ntMsgSeq ?? 0,
    event.clientSeq ?? event.msgSeq,
    event.time,
    event.msgId,
    event.sequenceAuthoritative !== false,
    event.senderUin === ctx.selfId ? 'outgoing' : 'incoming',
  );
  return convertAndDispatch(ctx, log, event, state);
}

function handleTempMessage(
  ctx: OneBotInstanceContext,
  log: Logger,
  event: Extract<QQEventVariant, { kind: 'temp_message' }>,
  state: EventTraceState,
): Promise<void> {
  cachePrivateMessageMeta(
    ctx,
    event.senderUin,
    event.msgSeq,
    event.ntMsgSeq ?? 0,
    event.clientSeq ?? 0,
    event.time,
    0,
    event.sequenceAuthoritative !== false,
    undefined,
  );
  ctx.tempSessions.record(event.senderUin, event.groupId);
  return convertAndDispatch(ctx, log, event, state);
}

function handleFriendRecall(
  ctx: OneBotInstanceContext,
  log: Logger,
  event: Extract<QQEventVariant, { kind: 'friend_recall' }>,
  state: EventTraceState,
): Promise<void> {
  const clientSequence = event.clientSeq ?? event.msgSeq;
  const recalled = ctx.messageStore.recordPrivateRecall(
    event.userUin,
    clientSequence,
    event.recalledBySelf === true,
    event.time,
  );
  let messageIdOverride: number | undefined;
  if (recalled !== null) {
    messageIdOverride = recalled;
  } else {
    log.debug(
      'friend recall cache miss peer=%d clientSeq=%d',
      event.userUin,
      clientSequence,
    );
  }
  return convertAndDispatch(ctx, log, event, state, messageIdOverride);
}

function handleGroupMsgEmojiLike(
  ctx: OneBotInstanceContext,
  log: Logger,
  event: Extract<QQEventVariant, { kind: 'group_msg_emoji_like' }>,
  state: EventTraceState,
): Promise<void> {
  cacheReaction(ctx, event);
  return convertAndDispatch(ctx, log, event, state);
}

function handlePttTransResult(
  _ctx: OneBotInstanceContext,
  log: Logger,
  event: Extract<QQEventVariant, { kind: 'ptt_trans_result' }>,
  state: EventTraceState,
): void {
  deliverPttTransText(pttTransKey(event.selfUin, event.msgId), event.text);
  traceEventTerminal(log, event.kind, state, 'internal', 'waiter_notified');
}

function convertOnly<K extends EventKind>(
  ctx: OneBotInstanceContext,
  log: Logger,
  event: Extract<QQEventVariant, { kind: K }>,
  state: EventTraceState,
): Promise<void> {
  return convertAndDispatch(ctx, log, event, state);
}

const EVENT_PIPELINE = {
  friend_message: { handle: handleFriendMessage },
  group_message: { handle: handleGroupMessage },
  temp_message: { handle: handleTempMessage },
  group_member_join: { handle: convertOnly },
  group_member_leave: { handle: convertOnly },
  group_mute: { handle: convertOnly },
  group_admin: { handle: convertOnly },
  friend_recall: { handle: handleFriendRecall },
  group_recall: { handle: convertOnly },
  friend_request: { handle: convertOnly },
  group_invite: { handle: convertOnly },
  friend_poke: { handle: convertOnly },
  group_poke: { handle: convertOnly },
  group_essence: { handle: convertOnly },
  group_file_upload: { handle: convertOnly },
  friend_add: { handle: convertOnly },
  friend_input_status: { handle: convertOnly },
  friend_profile_like: { handle: convertOnly },
  bot_offline: { handle: convertOnly },
  group_name_change: { handle: convertOnly },
  group_title_change: { handle: convertOnly },
  group_card_change: { handle: convertOnly },
  group_msg_emoji_like: { handle: handleGroupMsgEmojiLike },
  ptt_trans_result: { handle: handlePttTransResult },
  online_devices_changed: { drop: true },
  friend_remark_changed: { drop: true },
} as const satisfies PipelineRegistry;

type ConvertedKind = {
  [K in EventKind]: (typeof CONVERTERS)[K] extends null ? never : K
}[EventKind];

type DroppedKind = {
  [K in EventKind]: (typeof EVENT_PIPELINE)[K] extends { drop: true } ? K : never
}[EventKind];

type ConvertedButDropped = ConvertedKind & DroppedKind;
const _convertedKindsAreHandled: [ConvertedButDropped] extends [never] ? true : ConvertedButDropped = true;
void _convertedKindsAreHandled;
