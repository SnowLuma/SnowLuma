import { createHash } from 'node:crypto';

export const GROUP_MESSAGE_EVENT = 'group_message';
export const PRIVATE_MESSAGE_EVENT = 'private_message';
/** Legacy/fallback namespace for private messages sent by the current account. */
export const PRIVATE_SENT_MESSAGE_EVENT = 'private_message_sent';
/** Namespace for private messages keyed by QQ's conversation-wide NT sequence. */
export const PRIVATE_NT_MESSAGE_EVENT = 'private_message_nt';

export function privateMessageEventName(sentBySelf: boolean, hasNtSequence: boolean): string {
  if (hasNtSequence) return PRIVATE_NT_MESSAGE_EVENT;
  return sentBySelf ? PRIVATE_SENT_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT;
}

export function hashMessageIdInt32(sequence: number, sessionId: number, eventName: string): number {
  const seq = Number.isFinite(sequence) ? Math.trunc(sequence) : 0;
  const session = Number.isFinite(sessionId) ? Math.trunc(sessionId) : 0;
  const key = `${seq}:${session}:${eventName}`;
  const digest = createHash('sha1').update(key).digest();

  let id = digest.readInt32BE(0);
  if (id === 0) id = 1;
  return id;
}
