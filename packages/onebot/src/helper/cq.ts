import type { MessageElement } from '@snowluma/protocol/events';
import { CQ_REGEX, parseCQParams, ParseMessageOptions, segmentToElement } from '../message-parser';
import type { JsonArray, JsonObject } from '../types';


export function segmentToCQ(seg: JsonObject): string {
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
} export function segmentsToRawMessage(segments: JsonArray): string {
  return segments.map(seg => segmentToCQ(seg as JsonObject)).join('');
}
export function cqEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/,/g, '&#44;');
}
export function cqUnescape(text: string): string {
  // Order matters: `&amp;` MUST be last so that, e.g., `&amp;#91;` keeps
  // the literal `&#91;` instead of decoding twice into `[`.
  return text
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}
export async function parseFromCQString(message: string, options?: ParseMessageOptions): Promise<MessageElement[]> {
  const elements: MessageElement[] = [];
  let lastIndex = 0;

  for (const match of message.matchAll(CQ_REGEX)) {
    // Text before this CQ code
    if (match.index! > lastIndex) {
      const text = cqUnescape(message.substring(lastIndex, match.index!));
      if (text) elements.push({ type: 'text', text });
    }
    lastIndex = match.index! + match[0].length;

    const cqType = match[1];
    const params = parseCQParams(match[2] || '');
    const elem = await segmentToElement(cqType, params, options);
    if (elem) elements.push(elem);
  }

  // Trailing text
  if (lastIndex < message.length) {
    const text = cqUnescape(message.substring(lastIndex));
    if (text) elements.push({ type: 'text', text });
  }

  return elements;
}

