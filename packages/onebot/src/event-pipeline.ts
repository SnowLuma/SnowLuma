import { createLogger, getLogLevel, nextRequestId, runWithRequestId, type Logger } from '@snowluma/common/logger';
import { renderParamsVerbose } from '@snowluma/common/log-summary';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { convertEvent } from './event-converter';
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
    kind: QQEventVariant['kind'],
    start: () => void | Promise<void>,
  ): Promise<void> => {
    if (!accepting) return Promise.resolve();
    let operation: Promise<void>;
    try {
      operation = Promise.resolve(start());
    } catch (error) {
      operation = Promise.reject(error);
    }
    const tracked = operation.then(
      () => undefined,
      (error) => {
        log.error(
          'event pipeline handler failed kind=%s: %s',
          kind,
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        );
      },
    );
    inFlight.add(tracked);
    void tracked.then(() => { inFlight.delete(tracked); });
    return tracked;
  };

  disposers.push(
    ctx.bridge.events.on('group_message', (event) => track(event.kind, async () => {
      cacheGroupMessageMeta(ctx, event);
      await convertAndDispatch(ctx, log, event);
    })),
  );
  disposers.push(
    ctx.bridge.events.on('friend_message', (event) => track(event.kind, async () => {
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
      await convertAndDispatch(ctx, log, event);
    })),
  );
  disposers.push(
    ctx.bridge.events.on('temp_message', (event) => track(event.kind, async () => {
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
      // Record this group temp session so a later reply is limited to sessions
      // the peer opened.
      ctx.tempSessions.record(event.senderUin, event.groupId);
      await convertAndDispatch(ctx, log, event);
    })),
  );
  for (const kind of NOTICE_KINDS) {
    disposers.push(
      ctx.bridge.events.on(kind, (event) => track(event.kind, async () => {
        if (event.kind === 'group_msg_emoji_like') {
          cacheReaction(ctx, event);
        }
        let messageIdOverride: number | undefined;
        if (event.kind === 'friend_recall') {
          const clientSequence = event.clientSeq ?? event.msgSeq;
          const recalled = ctx.messageStore.recordPrivateRecall(
            event.userUin,
            clientSequence,
            event.recalledBySelf === true,
            event.time,
          );
          if (recalled !== null) {
            messageIdOverride = recalled;
          } else {
            log.debug(
              'friend recall cache miss peer=%d clientSeq=%d',
              event.userUin,
              clientSequence,
            );
          }
        }
        await convertAndDispatch(ctx, log, event, messageIdOverride);
      })),
    );
  }
  // Internal-only: voice-to-text result push. Not converted to a OneBot event —
  // it just unblocks the fetch_ptt_text call waiting on this msgId.
  disposers.push(
    ctx.bridge.events.on('ptt_trans_result', (event) => track(event.kind, () => {
      deliverPttTransText(pttTransKey(event.selfUin, event.msgId), event.text);
    })),
  );

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

const NOTICE_KINDS = [
  'group_member_join',
  'group_member_leave',
  'group_mute',
  'group_admin',
  'friend_recall',
  'group_recall',
  'friend_request',
  'group_invite',
  'friend_poke',
  'group_poke',
  'group_essence',
  'group_file_upload',
  'friend_add',
  'friend_input_status',
  'friend_profile_like',
  'bot_offline',
  'group_name_change',
  'group_title_change',
  'group_card_change',
  'group_msg_emoji_like',
] as const satisfies readonly QQEventVariant['kind'][];

async function convertAndDispatch(
  ctx: OneBotInstanceContext,
  log: Logger,
  event: QQEventVariant,
  messageIdOverride?: number,
): Promise<void> {
  // Inbound choke point — the receive-side mirror of the outbound api-handler.
  // Correlate the whole receive chain (decode → convert, incl. any rkey-fetch
  // packets the conversion triggers, → dispatch) under one [req#N]. Only pay
  // the AsyncLocalStorage wrap + id when trace is actually live.
  if (getLogLevel() !== 'trace') {
    await runConvertAndDispatch(ctx, log, event, messageIdOverride);
    return;
  }
  await runWithRequestId(nextRequestId(), () => (
    runConvertAndDispatch(ctx, log, event, messageIdOverride)
  ));
}

async function runConvertAndDispatch(
  ctx: OneBotInstanceContext,
  log: Logger,
  event: QQEventVariant,
  messageIdOverride?: number,
): Promise<void> {
  // Raw inbound event, memory-only (trace). Lazy → the deep render runs only
  // when trace is live.
  log.trace(() => [`recv ${event.kind} ⇐ %s`, renderParamsVerbose(event)]);
  const startedAt = Date.now();
  const converted = await convertEvent(ctx.converterCtx, event);
  if (!converted) {
    log.trace(() => [`recv ${event.kind} ⇒ dropped (${Date.now() - startedAt}ms)`]);
    return;
  }
  if (messageIdOverride !== undefined && event.kind === 'friend_recall') {
    converted.message_id = messageIdOverride;
  }
  if (event.kind === 'friend_message' && isFriendMessageRecalled(ctx, log, event)) return;
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
  }
  // Backfill can await several network/media operations. Re-check immediately
  // before dispatch so a recall that arrived during that gap wins the race.
  if (event.kind === 'friend_message' && isFriendMessageRecalled(ctx, log, event)) return;
  ctx.dispatchEvent(converted, 'bridge');
  log.trace(() => [`recv ${event.kind} ⇒ ${String(converted.post_type ?? '?')} (${Date.now() - startedAt}ms)`]);
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
