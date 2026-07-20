import type { JsonObject } from './types';

export const SELF_SENT_ECHO_WINDOW_MS = 120_000;

/**
 * Match the action-side copy of a sent message with QQ's later canonical
 * echo. The message hash alone is insufficient because it is a signed 32-bit
 * value and can collide; sequence, conversation and a bounded time window are
 * part of the identity as well.
 */
export function sameSelfSentMessage(left: JsonObject, right: JsonObject): boolean {
  const leftKey = selfSentEventKey(left);
  const rightKey = selfSentEventKey(right);
  if (leftKey === null || leftKey !== rightKey) return false;

  const leftTime = toInt(left.time);
  const rightTime = toInt(right.time);
  return leftTime > 0
    && rightTime > 0
    && Math.abs(leftTime - rightTime) * 1000 <= SELF_SENT_ECHO_WINDOW_MS;
}

/** Stable identity for a self-sent event, excluding its bounded timestamp. */
export function selfSentEventKey(event: JsonObject): string | null {
  if (event.post_type !== 'message_sent') return null;
  if (event.message_type !== 'private' && event.message_type !== 'group') return null;

  const messageId = toInt(event.message_id);
  const sequence = toInt(event.message_seq);
  const session = event.message_type === 'group'
    ? toInt(event.group_id)
    : (toInt(event.target_id) || toInt(event.user_id));
  if (messageId === 0 || sequence <= 0 || session <= 0) return null;
  return `${event.message_type}:${session}:${sequence}:${messageId}`;
}

function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}
