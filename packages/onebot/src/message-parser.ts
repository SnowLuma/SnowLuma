import { createLogger } from '@snowluma/common/logger';
import type { MessageElement } from '@snowluma/protocol/events';
import {
  assertValidMessageElement,
  ELEMENT_MANIFEST,
  MessageElementValidationError,
} from '@snowluma/protocol/element-manifest';
import { parseFromCQString } from './helper/cq';
import { getElementCodec, intOr } from './event-converter/element-codecs';
import type { JsonValue } from './types';

const log = createLogger('MsgParser');

export { MessageElementValidationError } from '@snowluma/protocol/element-manifest';

export interface ParseMessageOptions {
  resolveReplySequence?: (replyMessageId: number) => number | null;
  resolveReplyMeta?: (replyMessageId: number) => {
    senderUin: number;
    time: number;
    random: number;
    sequenceAuthoritative?: boolean;
  } | null;
  resolveMentionUid?: (targetUin: number) => string | null | Promise<string | null>;
  resolveContactArk?: (contactType: string, contactId: number) => string | null | Promise<string | null>;
  musicSignUrl?: string;
}

// --- CQ Code parsing ---

export const CQ_REGEX = /\[CQ:([A-Za-z][A-Za-z0-9_]*)(?:,([^\]]*))?\]/g;

export function parseCQParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!raw) return params;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      params[pair.substring(0, eq)] = pair.substring(eq + 1)
        .replace(/&#91;/g, '[')
        .replace(/&#93;/g, ']')
        .replace(/&#44;/g, ',')
        .replace(/&amp;/g, '&');
    }
  }
  return params;
}

// --- JSON segment parsing ---

interface MessageSegment {
  type: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

function isSegmentArray(val: unknown): val is MessageSegment[] {
  return Array.isArray(val) && val.every(
    (item) => typeof item === 'object' && item !== null && !Array.isArray(item)
      && typeof (item as { type?: unknown }).type === 'string'
      && (item as { type: string }).type.trim().length > 0,
  );
}

function invalidMessageShape(message: string): MessageElementValidationError {
  return new MessageElementValidationError('MISSING_FIELD', message, undefined, 'message');
}

function validatedOutboundElement(element: MessageElement): MessageElement {
  // P validates the OneBot→MessageElement conversion; W ensures the resulting
  // element can actually enter QQ's message-element send pipeline. Keeping
  // both checks here makes parseMessage all-or-nothing before any send starts.
  assertValidMessageElement(element, 'P');
  assertValidMessageElement(element, 'W');
  return element;
}

function assertScalarSegmentData(type: string, data: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(data)) {
    if (
      value === undefined
      || value === null
      || typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) continue;
    throw new MessageElementValidationError(
      'INVALID_FIELD',
      `message segment "${type}" field "${field}" must be a scalar value`,
      type,
      field,
    );
  }
}

function requireNonEmptyStringField(
  type: string,
  data: Record<string, unknown>,
  field: string,
): string {
  const value = data[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new MessageElementValidationError(
      'INVALID_FIELD',
      `message segment "${type}" field "${field}" must be a non-empty string`,
      type,
      field,
    );
  }
  return value;
}

function requireCoordinate(
  data: Record<string, unknown>,
  field: 'lat' | 'lon',
): string {
  const raw = data[field];
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  const value = Number(text);
  const limit = field === 'lat' ? 90 : 180;
  if (!text.trim() || text !== text.trim() || !Number.isFinite(value) || value < -limit || value > limit) {
    throw new MessageElementValidationError(
      'INVALID_FIELD',
      `message segment "location" field "${field}" must be a finite coordinate between ${String(-limit)} and ${String(limit)}`,
      'location',
      field,
    );
  }
  return text;
}

export async function segmentToElement(type: string, data: Record<string, unknown>, options?: ParseMessageOptions): Promise<MessageElement | null> {
  const normalizedType = type.toLowerCase();

  // Ordinary OneBot segment fields are scalar. Reject objects/arrays before
  // codecs can stringify them into "[object Object]" and alter caller intent.
  // Forward nodes deliberately own nested content but are rejected by their
  // dedicated normal-send branch below; anonymous is rejected regardless of
  // payload, so neither needs the scalar guard.
  if (normalizedType !== 'node' && normalizedType !== 'anonymous') {
    assertScalarSegmentData(normalizedType, data);
  }

  // 纯 OneBot 输入词：可执行的塌缩成 json/face；没有合法发送语义的 node / shake /
  // anonymous 在这里明确拒绝。它们无收侧对应、无专属 wire 形态，故不进 codec 表。
  // 真实元素（收发同名）走下方的 ELEMENT_CODECS。
  switch (normalizedType) {
    case 'node': {
      // Forward-node arrays are consumed by parseForwardNodes before reaching
      // this function. A node mixed into a normal message is not sendable.
      throw new MessageElementValidationError(
        'UNSENDABLE_TYPE',
        'message segment "node" is only valid inside a forward node list',
        normalizedType,
      );
    }
    case 'share': {
      // Link share — map to json card message
      const url = requireNonEmptyStringField(normalizedType, data, 'url');
      const title = requireNonEmptyStringField(normalizedType, data, 'title');
      const content = String(data.content ?? '');
      const image = String(data.image ?? '');
      const jsonData = JSON.stringify({
        app: 'com.tencent.structmsg',
        view: 'news',
        prompt: title,
        meta: { news: { title, desc: content, jumpUrl: url, preview: image } },
      });
      return validatedOutboundElement({ type: 'json', text: jsonData });
    }
    case 'music': {
      // Music share — uses external signing service (NapCat-compatible)
      const musicType = requireNonEmptyStringField(normalizedType, data, 'type');
      // Non-custom platform names are deliberately open: musicSignUrl is
      // configurable and private signers may support platforms beyond the
      // built-in NapCat set. Their executable contract is non-empty type+id.
      if (musicType === 'custom') {
        requireNonEmptyStringField(normalizedType, data, 'url');
        requireNonEmptyStringField(normalizedType, data, 'audio');
        requireNonEmptyStringField(normalizedType, data, 'title');
      } else if (data.id === undefined || data.id === null || String(data.id).trim() === '') {
        throw new MessageElementValidationError(
          'MISSING_FIELD',
          'message segment "music" requires field "id" for a platform card',
          normalizedType,
          'id',
        );
      }
      const signUrl = options?.musicSignUrl || 'https://ss.xingzhige.com/music_card/card';
      try {
        let postData: Record<string, unknown>;
        if (musicType === 'custom') {
          postData = {
            type: 'custom',
            id: undefined,
            url: String(data.url ?? ''),
            audio: String(data.audio ?? ''),
            title: String(data.title ?? ''),
            image: String(data.image ?? ''),
            singer: String(data.content ?? ''),
          };
        } else {
          postData = { type: musicType, id: String(data.id ?? '') };
        }
        const resp = await fetch(signUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(postData),
        });
        if (!resp.ok) throw new Error(`music sign HTTP ${resp.status}`);
        const musicJson = await resp.text();
        return validatedOutboundElement({ type: 'json', text: musicJson });
      } catch (e) {
        log.warn('music sign failed: %s, falling back to local card', e instanceof Error ? e.message : String(e));
        // Fallback: build a basic card locally
        const title = String(data.title ?? 'Music');
        const jsonData = JSON.stringify({
          app: 'com.tencent.structmsg',
          view: 'music',
          prompt: `[音乐]${title}`,
          meta: {
            music: {
              title,
              desc: String(data.content ?? ''),
              jumpUrl: String(data.url ?? ''),
              musicUrl: String(data.audio ?? ''),
              preview: String(data.image ?? ''),
            },
          },
        });
        return validatedOutboundElement({ type: 'json', text: jsonData });
      }
    }
    case 'location': {
      // Location — map to json card
      const lat = requireCoordinate(data, 'lat');
      const lon = requireCoordinate(data, 'lon');
      const title = String(data.title ?? '位置');
      const content = String(data.content ?? `${lat},${lon}`);
      const jsonData = JSON.stringify({
        app: 'com.tencent.map',
        view: 'LocationShare',
        prompt: `[位置]${title}`,
        meta: { Location: { lat, lng: lon, title, address: content } },
      });
      return validatedOutboundElement({ type: 'json', text: jsonData });
    }
    case 'contact': {
      // Contact card — map to json card
      const contactType = requireNonEmptyStringField(normalizedType, data, 'type');
      if (contactType !== 'qq' && contactType !== 'group') {
        throw new MessageElementValidationError(
          'INVALID_FIELD',
          'message segment "contact" field "type" must be "qq" or "group"',
          normalizedType,
          'type',
        );
      }
      const contactId = String(data.id ?? '').trim();
      const numericId = intOr(contactId, 0);
      if (numericId <= 0) {
        throw new MessageElementValidationError(
          'INVALID_FIELD',
          'message segment "contact" field "id" must be a positive integer',
          normalizedType,
          'id',
        );
      }
      const normalizedContactType = contactType.trim().toLowerCase();
      if (numericId > 0 && options?.resolveContactArk && (normalizedContactType === 'qq' || normalizedContactType === 'group')) {
        const ark = await options.resolveContactArk(contactType, numericId);
        if (!ark) throw new Error(`contact ark unavailable for ${contactType}:${numericId}`);
        return validatedOutboundElement({ type: 'json', text: ark });
      }
      const jsonData = JSON.stringify({
        app: 'com.tencent.contact.lua',
        view: 'contact',
        prompt: `[推荐${contactType === 'group' ? '群' : '好友'}]`,
        meta: { contact: { type: contactType, id: contactId } },
      });
      return validatedOutboundElement({ type: 'json', text: jsonData });
    }
    case 'rps': {
      // Rock-paper-scissors — map to dice-like face
      return validatedOutboundElement({ type: 'face', faceId: 359 });
    }
    case 'dice': {
      // Dice — map to dice face
      return validatedOutboundElement({ type: 'face', faceId: 358 });
    }
    case 'shake': {
      // Window shake normalizes to poke, then the W-direction guard returns the
      // same explicit "use the dedicated poke Action" validation error.
      return validatedOutboundElement({ type: 'poke', subType: 1 });
    }
    case 'anonymous': {
      throw new MessageElementValidationError(
        'UNSENDABLE_TYPE',
        'message segment "anonymous" has no executable send semantics',
        normalizedType,
      );
    }
  }

  // 真实元素（P 发·解，段 type 与 element.type 同名）：查 codec 表。
  // 见 event-converter/element-codecs.ts。
  const codec = getElementCodec(normalizedType);
  if (codec?.fromSegment) {
    const element = await codec.fromSegment(data, options);
    if (!element) {
      throw new MessageElementValidationError(
        'MISSING_FIELD',
        `message segment "${normalizedType}" is missing required or usable fields`,
        normalizedType,
      );
    }
    return validatedOutboundElement(element);
  }

  if (Object.hasOwn(ELEMENT_MANIFEST, normalizedType)) {
    // Known receive-only/by-design-no type (currently flash_file). Ask the
    // executable manifest for the stable error + dedicated-Action hint.
    assertValidMessageElement({ type: normalizedType }, 'P');
  }
  throw new MessageElementValidationError(
    'UNKNOWN_TYPE',
    `unknown message segment type: ${type}`,
    normalizedType,
  );
}

function segmentPayload(seg: MessageSegment): Record<string, unknown> {
  const topLevel = { ...seg } as Record<string, unknown>;
  delete topLevel.type;
  delete topLevel.data;
  const nested = (seg.data && typeof seg.data === 'object' && !Array.isArray(seg.data))
    ? seg.data
    : {};
  return { ...topLevel, ...nested };
}

// --- Public API ---

export async function parseMessage(message: JsonValue, autoEscape: boolean, options?: ParseMessageOptions): Promise<MessageElement[]> {
  if (typeof message === 'string') {
    if (message.length === 0) throw invalidMessageShape('message must not be empty');
    if (autoEscape) {
      return [validatedOutboundElement({ type: 'text', text: message })];
    }
    const elements = await parseFromCQString(message, options);
    if (elements.length === 0) throw invalidMessageShape('message must contain at least one sendable segment');
    return elements;
  }

  if (Array.isArray(message)) {
    if (!isSegmentArray(message)) {
      throw new MessageElementValidationError(
        'INVALID_FIELD',
        'message segment array entries must be objects with a non-empty string type',
        undefined,
        'message',
      );
    }
    if (message.length === 0) throw invalidMessageShape('message segment array must not be empty');
    const elements: MessageElement[] = [];
    for (const seg of message) {
      const data = segmentPayload(seg);
      const elem = await segmentToElement(seg.type, data, options);
      if (elem) elements.push(elem);
    }
    if (elements.length === 0) throw invalidMessageShape('message must contain at least one sendable segment');
    return elements;
  }

  // Single segment object
  if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
    const seg = message as unknown as MessageSegment;
    if (typeof seg.type === 'string' && seg.type.trim()) {
      const data = segmentPayload(seg);
      const elem = await segmentToElement(seg.type, data, options);
      if (elem) return [elem];
      throw invalidMessageShape('message must contain at least one sendable segment');
    }
    throw new MessageElementValidationError(
      'MISSING_FIELD',
      'single message segment requires a non-empty string type',
      undefined,
      'type',
    );
  }

  throw new MessageElementValidationError(
    'INVALID_FIELD',
    'message must be a string, a segment object, or a segment array',
    undefined,
    'message',
  );
}
