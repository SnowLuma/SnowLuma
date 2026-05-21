import { createHash } from 'node:crypto';

export const GROUP_MESSAGE_EVENT = 'group_message';
export const PRIVATE_MESSAGE_EVENT = 'private_message';

export function hashMessageIdInt32(sequence: number, sessionId: number, eventName: string): number {
  const seq = Number.isFinite(sequence) ? Math.trunc(sequence) : 0;
  const session = Number.isFinite(sessionId) ? Math.trunc(sessionId) : 0;
  const key = `${seq}:${session}:${eventName}`;
  const digest = createHash('sha1').update(key).digest();

  let id = digest.readInt32BE(0);
  if (id === 0) id = 1;
  return id;
}
