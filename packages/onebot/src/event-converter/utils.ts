import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT } from '../message-id';
import type { JsonArray, JsonObject } from '../types';
import type { MessageIdResolver } from './index';

export function parseSelfId(instanceUin: string): number {
  const parsed = Number.parseInt(instanceUin, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Two QQEvent actors are "the same" when their uins match, or their
 * uids match when uins aren't available. Used by the group_member_join
 * sub-type calculation (self-approve vs. invite).
 */
export function isSameActor(
  leftUin: number,
  leftUid: string | undefined,
  rightUin: number,
  rightUid: string | undefined,
): boolean {
  if (leftUin > 0 && rightUin > 0) return leftUin === rightUin;
  return Boolean(leftUid) && leftUid === rightUid;
}

/**
 * Run the optional MessageId resolver, falling back to the raw
 * sequence when no resolver is wired or it returns 0.
 */
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

// ─────────────── raw_message (CQ string) generation ───────────────

function cqEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/,/g, '&#44;');
}

export function segmentsToRawMessage(segments: JsonArray): string {
  return segments.map(seg => segmentToCQ(seg as JsonObject)).join('');
}

function segmentToCQ(seg: JsonObject): string {
  const type = String(seg.type ?? '');
  const data = (seg.data ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'text':
      return cqEscape(String(data.text ?? ''));
    case 'face':
      return `[CQ:face,id=${data.id ?? 0}]`;
    case 'image':
      return `[CQ:image,file=${cqEscape(String(data.file ?? ''))},url=${cqEscape(String(data.url ?? ''))}]`;
    case 'at':
      return `[CQ:at,qq=${data.qq ?? ''}]`;
    case 'reply':
      return `[CQ:reply,id=${data.id ?? 0}]`;
    case 'record':
      return `[CQ:record,file=${cqEscape(String(data.file ?? ''))},url=${cqEscape(String(data.url ?? ''))}]`;
    case 'video':
      return `[CQ:video,file=${cqEscape(String(data.file ?? ''))},url=${cqEscape(String(data.url ?? ''))}]`;
    case 'json':
      return `[CQ:json,data=${cqEscape(String(data.data ?? ''))}]`;
    case 'xml':
      return `[CQ:xml,data=${cqEscape(String(data.data ?? ''))}]`;
    case 'forward':
      return `[CQ:forward,id=${cqEscape(String(data.id ?? ''))}]`;
    case 'mface':
      return `[CQ:mface,name=${cqEscape(String(data.name ?? ''))}]`;
    case 'poke':
      return `[CQ:poke,type=${data.type ?? 0}]`;
    case 'file':
      return `[CQ:file,name=${cqEscape(String(data.name ?? ''))},size=${data.size ?? 0},id=${cqEscape(String(data.id ?? ''))},url=${cqEscape(String(data.url ?? ''))}]`;
    default:
      return `[CQ:${type}]`;
  }
}
