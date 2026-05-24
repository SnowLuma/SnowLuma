import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT } from '../message-id';
import type { MessageIdResolver } from './index';

export function parseSelfId(instanceUin: string): number {
  const parsed = Number.parseInt(instanceUin, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function isSameActor(
  leftUin: number,
  leftUid: string | undefined,
  rightUin: number,
  rightUid: string | undefined,
): boolean {
  if (leftUin > 0 && rightUin > 0) return leftUin === rightUin;
  return Boolean(leftUid) && leftUid === rightUid;
}

export function applyMessageIdResolver(
  resolver: MessageIdResolver | null,
  isGroup: boolean,
  sessionId: number,
  sequence: number,
  eventName: string,
): number {
  if (resolver) {
    const resolved = resolver(isGroup, sessionId, sequence, eventName);
    if (Number.isInteger(resolved) && resolved !== 0) return resolved;
  }
  const seq = Math.trunc(sequence);
  return seq === 0 ? 0 : seq;
}

export function resolveReplyId(
  isGroup: boolean,
  sessionId: number,
  sequence: number,
  resolver?: MessageIdResolver | null,
): number {
  const seq = Math.trunc(sequence);
  if (seq === 0) return 0;

  if (resolver) {
    const eventName = isGroup ? GROUP_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT;
    const resolved = resolver(isGroup, sessionId, seq, eventName);
    if (Number.isInteger(resolved) && resolved !== 0) return resolved;
  }

  return seq;
}
