import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT } from '../message-id';
import type { MessageIdResolver } from './index';
import type { MessageElement } from '@snowluma/protocol/events';

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
  timestamp?: number,
): number {
  if (resolver) {
    const resolved = resolver(isGroup, sessionId, sequence, eventName, timestamp);
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
  eventName = isGroup ? GROUP_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT,
  timestamp?: number,
  replyElements?: readonly MessageElement[],
): number {
  const seq = Math.trunc(sequence);
  if (seq === 0) return 0;

  if (resolver) {
    const resolved = resolver(isGroup, sessionId, seq, eventName, timestamp, replyElements);
    if (Number.isInteger(resolved) && resolved !== 0) return resolved;
  }

  return seq;
}
