import { normalizeMessage, chain } from './chain';
import { escapeCqText, segmentsToCQString } from './cq-format';
import { segments } from './segments';
import type { AnyMessageSegment, OutgoingMessage } from '../types/index';

const CQ_REGEX = /\[CQ:([a-zA-Z0-9_.-]+)(?:,([^\]]*))?\]/g;

export function toCQString(input: OutgoingMessage): string {
  if (typeof input === 'string') return escapeCqText(input);
  const normalized = normalizeMessage(input);
  return typeof normalized === 'string'
    ? escapeCqText(normalized)
    : segmentsToCQString(normalized);
}

export function fromCQString(input: string) {
  let current = chain();
  let lastIndex = 0;

  for (const match of input.matchAll(CQ_REGEX)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      const textValue = cqUnescape(input.slice(lastIndex, index));
      if (textValue) current = current.text(textValue);
    }

    const segment = segmentFromCq(match[1] ?? '', parseCQParams(match[2] ?? ''));
    if (segment) current = current.append(segment);
    lastIndex = index + match[0].length;
  }

  if (lastIndex < input.length) {
    const textValue = cqUnescape(input.slice(lastIndex));
    if (textValue) current = current.text(textValue);
  }

  return current;
}

export function parseSegments(input: string): AnyMessageSegment[] {
  return fromCQString(input).toSegments();
}

function parseCQParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!raw) return params;

  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    params[pair.slice(0, eq)] = cqUnescapeParam(pair.slice(eq + 1));
  }

  return params;
}

function cqUnescape(text: string): string {
  return text
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

function cqUnescapeParam(text: string): string {
  return cqUnescape(text).replace(/&#44;/g, ',');
}

function segmentFromCq(type: string, data: Record<string, string>): AnyMessageSegment | null {
  switch (type) {
    case 'text':
      return segments.text(data.text ?? '');
    case 'face':
      if (data.large === undefined) return segments.face(data.id ?? '0');
      if (data.large === 'true' || data.large === '1') return segments.face(data.id ?? '0', { large: true });
      if (data.large === 'false' || data.large === '0') return segments.face(data.id ?? '0', { large: false });
      throw new Error('face.large must be true, false, 1, or 0');
    case 'at':
      if (data.qq === 'all') return segments.at('all');
      {
        const qq = Number(data.qq);
        return Number.isFinite(qq) && qq > 0
          ? segments.at(qq, { name: data.name, uid: data.uid })
          : segments.raw(type, data);
      }
    case 'reply':
      return segments.reply(data.id ?? '0');
    case 'image':
      return segments.image(data.file ?? data.url ?? '', {
        url: data.url,
        type: data.type === 'flash' ? 'flash' : undefined,
        summary: data.summary,
      });
    case 'record':
      return segments.record(data.file ?? data.url ?? '', { url: data.url });
    case 'video':
      return segments.video(data.file ?? data.url ?? '', { url: data.url, thumb: data.thumb });
    case 'json':
      return segments.json(data.data ?? '');
    case 'xml':
      return segments.xml(data.data ?? '', { id: data.id });
    case 'poke':
      return segments.poke(data.type ?? data.id ?? '0', data.id);
    case 'forward':
      return segments.forward(data.id ?? data.res_id ?? data.forward_id ?? '');
    default:
      return segments.raw(type, data);
  }
}
