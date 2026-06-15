import { createLogger, getLogLevel, nextRequestId, runWithRequestId, type Logger } from '@snowluma/common/logger';
import { renderParamsVerbose } from '@snowluma/common/log-summary';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { convertEvent } from './event-converter';
import type { OneBotInstanceContext } from './instance-context';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT, hashMessageIdInt32 } from './message-id';
import { backfillReplyTarget } from './modules/message-actions';
import { deliverPttTransText, pttTransKey } from './modules/ptt-trans-waiter';

const moduleLog = createLogger('Event');

export function registerEventPipeline(ctx: OneBotInstanceContext): () => void {
  const uinNum = Number.parseInt(ctx.uin, 10);
  const log = Number.isFinite(uinNum) && uinNum > 0 ? moduleLog.child({ uin: uinNum }) : moduleLog;
  const disposers: Array<() => void> = [];
  disposers.push(
    ctx.bridge.events.on('group_message', async (event) => {
      cacheGroupMessageMeta(ctx, event);
      await convertAndDispatch(ctx, log, event);
    }),
  );
  disposers.push(
    ctx.bridge.events.on('friend_message', async (event) => {
      cachePrivateMessageMeta(ctx, event.senderUin, event.msgSeq, event.time, event.msgId);
      await convertAndDispatch(ctx, log, event);
    }),
  );
  disposers.push(
    ctx.bridge.events.on('temp_message', async (event) => {
      cachePrivateMessageMeta(ctx, event.senderUin, event.msgSeq, event.time, 0);
      await convertAndDispatch(ctx, log, event);
    }),
  );
  for (const kind of NOTICE_KINDS) {
    disposers.push(
      ctx.bridge.events.on(kind, async (event) => {
        if (event.kind === 'group_msg_emoji_like') {
          cacheReaction(ctx, event);
        }
        await convertAndDispatch(ctx, log, event);
      }),
    );
  }
  // Internal-only: voice-to-text result push. Not converted to a OneBot event —
  // it just unblocks the fetch_ptt_text call waiting on this msgId.
  disposers.push(
    ctx.bridge.events.on('ptt_trans_result', (event) => {
      deliverPttTransText(pttTransKey(event.selfUin, event.msgId), event.text);
    }),
  );

  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* ignore */ }
    }
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
  'group_msg_emoji_like',
] as const satisfies readonly QQEventVariant['kind'][];

async function convertAndDispatch(ctx: OneBotInstanceContext, log: Logger, event: QQEventVariant): Promise<void> {
  // Inbound choke point — the receive-side mirror of the outbound api-handler.
  // Correlate the whole receive chain (decode → convert, incl. any rkey-fetch
  // packets the conversion triggers, → dispatch) under one [req#N]. Only pay
  // the AsyncLocalStorage wrap + id when trace is actually live.
  if (getLogLevel() !== 'trace') {
    await runConvertAndDispatch(ctx, log, event);
    return;
  }
  await runWithRequestId(nextRequestId(), () => runConvertAndDispatch(ctx, log, event));
}

async function runConvertAndDispatch(ctx: OneBotInstanceContext, log: Logger, event: QQEventVariant): Promise<void> {
  // Raw inbound event, memory-only (trace). Lazy → the deep render runs only
  // when trace is live.
  log.trace(() => [`recv ${event.kind} ⇐ %s`, renderParamsVerbose(event)]);
  const startedAt = Date.now();
  const converted = await convertEvent(ctx.converterCtx, event);
  if (!converted) {
    log.trace(() => [`recv ${event.kind} ⇒ dropped (${Date.now() - startedAt}ms)`]);
    return;
  }
  // If this message quotes one we don't have, fetch + persist it first (gated +
  // throttled) so a consumer's get_msg on the quote resolves. No-op for the
  // common case (no reply, or the quoted message is already stored). Never let a
  // back-fill failure block delivery of the live message.
  try {
    await backfillReplyTarget(ctx, event);
  } catch { /* best-effort — dispatch the live event regardless */ }
  ctx.dispatchEvent(converted);
  log.trace(() => [`recv ${event.kind} ⇒ ${String(converted.post_type ?? '?')} (${Date.now() - startedAt}ms)`]);
}

function cacheGroupMessageMeta(ctx: OneBotInstanceContext, event: Extract<QQEventVariant, { kind: 'group_message' }>): void {
  const messageId = hashMessageIdInt32(event.msgSeq, event.groupId, GROUP_MESSAGE_EVENT);
  ctx.cacheMessageMeta(messageId, {
    isGroup: true,
    targetId: event.groupId,
    sequence: event.msgSeq,
    eventName: GROUP_MESSAGE_EVENT,
    clientSequence: 0,
    random: event.msgId,
    timestamp: event.time,
  });
}

function cachePrivateMessageMeta(
  ctx: OneBotInstanceContext,
  senderUin: number,
  msgSeq: number,
  timestamp: number,
  random: number,
): void {
  const messageId = hashMessageIdInt32(msgSeq, senderUin, PRIVATE_MESSAGE_EVENT);
  ctx.cacheMessageMeta(messageId, {
    isGroup: false,
    targetId: senderUin,
    sequence: msgSeq,
    eventName: PRIVATE_MESSAGE_EVENT,
    clientSequence: 0,
    random,
    timestamp,
  });
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
