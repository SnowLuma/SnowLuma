import type { FriendMessage } from '@snowluma/protocol/events';
import {
  GROUP_MESSAGE_EVENT,
  privateMessageEventName,
} from './message-id';
import type { MessageStore } from './message-store';
import type { JsonObject } from './types';

/**
 * Persist a converted server-history event without dispatching it.
 *
 * Private history needs the conversation peer explicitly because `user_id`
 * names the sender and therefore equals the bot account on outgoing messages.
 */
export function persistHistoryEvent(
  store: MessageStore,
  event: JsonObject,
  privatePeerId?: number,
  source?: FriendMessage,
): void {
  const messageId = toHistoryInt(event.message_id);
  if (!Number.isSafeInteger(messageId) || messageId === 0) {
    throw new Error(`history event has invalid message_id ${String(event.message_id)}`);
  }
  if (event.message_type !== 'group' && event.message_type !== 'private') {
    throw new Error(`history event has invalid message_type ${String(event.message_type)}`);
  }
  const isGroup = event.message_type === 'group';
  const sessionId = isGroup
    ? toHistoryInt(event.group_id)
    : (privatePeerId && privatePeerId > 0 ? privatePeerId : toHistoryInt(event.user_id));
  const messageSequence = toHistoryInt(event.message_seq);
  const sequence = source?.ntMsgSeq ?? messageSequence;
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
    throw new Error(`history event has invalid session id ${String(sessionId)}`);
  }
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error(`history event has invalid sequence ${String(sequence)}`);
  }
  const sequenceAuthoritative = source?.sequenceAuthoritative !== false && sequence > 0;
  const isOutgoingPrivate = !isGroup && source?.senderUin === source?.selfUin;
  const eventName = isGroup
    ? GROUP_MESSAGE_EVENT
    : source
      ? privateMessageEventName(isOutgoingPrivate, sequenceAuthoritative)
      : privateMessageEventName(event.post_type === 'message_sent', false);
  const meta = !isGroup && source
    ? {
      isGroup: false,
      targetId: sessionId,
      sequence,
      sequenceAuthoritative,
      eventName,
      clientSequence: source.clientSeq ?? source.msgSeq,
      privateDirection: source.senderUin === source.selfUin
        ? 'outgoing'
        : 'incoming',
      random: source.msgId,
      timestamp: source.time,
    } satisfies Parameters<MessageStore['storeMeta']>[1]
    : undefined;
  store.storeHistoryEvent(
    messageId,
    isGroup,
    sessionId,
    sequence,
    eventName,
    event,
    { sequenceAuthoritative, meta },
  );
}

export function toHistoryInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const number = Number(value);
    if (Number.isFinite(number)) return Math.trunc(number);
  }
  return 0;
}
