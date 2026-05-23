import type { QQEventVariant } from '@snowluma/protocol/events';
import { convertEvent } from './event-converter';
import type { OneBotInstanceContext } from './instance-context';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT, hashMessageIdInt32 } from './message-id';

/**
 * Subscribe every `OneBotInstanceContext`-aware handler onto the bridge
 * event bus. Returns a disposer that removes every subscription registered
 * here in one shot — useful for tests and for tearing down a session.
 */
export function registerEventPipeline(ctx: OneBotInstanceContext): () => void {
  const disposers: Array<() => void> = [];

  // Every kind that maps onto an OB11 message event also seeds the
  // message-meta cache; we do that synchronously before async conversion so
  // reply / quote lookups for that message id work even if the converter
  // takes a beat to finish (e.g. while resolving image URLs).
  disposers.push(
    ctx.bridge.events.on('group_message', async (event) => {
      cacheGroupMessageMeta(ctx, event);
      await convertAndDispatch(ctx, event);
    }),
  );
  disposers.push(
    ctx.bridge.events.on('friend_message', async (event) => {
      cachePrivateMessageMeta(ctx, event.senderUin, event.msgSeq, event.time, event.msgId);
      await convertAndDispatch(ctx, event);
    }),
  );
  disposers.push(
    ctx.bridge.events.on('temp_message', async (event) => {
      cachePrivateMessageMeta(ctx, event.senderUin, event.msgSeq, event.time, 0);
      await convertAndDispatch(ctx, event);
    }),
  );

  // Notice / request / non-message events: no meta caching needed, just
  // convert and dispatch.
  for (const kind of NOTICE_KINDS) {
    disposers.push(
      ctx.bridge.events.on(kind, async (event) => {
        // Side-effect: write emoji-reaction events to the local cache
        // BEFORE converting / dispatching, so a fetch_emoji_like that
        // races with the push still sees the new row.
        if (event.kind === 'group_msg_emoji_like') {
          cacheReaction(ctx, event);
        }
        await convertAndDispatch(ctx, event);
      }),
    );
  }

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

async function convertAndDispatch(ctx: OneBotInstanceContext, event: QQEventVariant): Promise<void> {
  const converted = await convertEvent(ctx.converterCtx, event);
  if (!converted) return;
  ctx.dispatchEvent(converted);
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
  // `isAdd=true` means the operator just reacted; `isAdd=false` means
  // the reaction was withdrawn. The decoder already normalizes both
  // directions onto this single event kind. `emojiType` isn't on the
  // push event payload — we default to 1 (QQ-face) which matches every
  // observed reaction so far; the field is a known unknown and can be
  // refined later if a wire dump shows it.
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
