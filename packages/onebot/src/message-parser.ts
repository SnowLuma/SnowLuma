import { createLogger } from '@snowluma/common/logger';
import type { MessageElement } from '@snowluma/protocol/events';
import {
  assertVideoSendPolicy,
  assertWindowShakeSendPolicy,
  assertValidMessageElement,
  ELEMENT_MANIFEST,
  MessageElementValidationError,
  type OutboundMessageScene,
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
  data?: unknown;
  [key: string]: unknown;
}

function isSegmentArray(val: unknown): val is MessageSegment[] {
  return Array.isArray(val) && val.every(
    (item) => typeof item === 'object' && item !== null && !Array.isArray(item)
      && typeof (item as { type?: unknown }).type === 'string'
      && (item as { type: string }).type.trim().length > 0,
  );
}

function normalizeSegmentType(type: string): string {
  return type.toLowerCase();
}

interface OutboundInputSegmentSummary {
  rawTypes: string[];
  effectiveVideoTypes: string[];
}

function isExplicitEmptyTextPlaceholder(segment: MessageSegment): boolean {
  return normalizeSegmentType(segment.type) === 'text'
    && segmentPayload(segment).text === '';
}

function outboundInputSegmentSummary(
  message: JsonValue,
  autoEscape: boolean,
): OutboundInputSegmentSummary {
  if (typeof message === 'string') {
    if (autoEscape) return { rawTypes: ['text'], effectiveVideoTypes: ['text'] };
    const types: string[] = [];
    let lastIndex = 0;
    for (const match of message.matchAll(CQ_REGEX)) {
      if (match.index! > lastIndex) types.push('text');
      types.push(normalizeSegmentType(match[1] ?? ''));
      lastIndex = match.index! + match[0].length;
    }
    if (lastIndex < message.length) types.push('text');
    return { rawTypes: types, effectiveVideoTypes: types };
  }
  if (Array.isArray(message)) {
    const rawTypes: string[] = [];
    const effectiveVideoTypes: string[] = [];
    for (const item of message) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const type = (item as { type?: unknown }).type;
      if (typeof type !== 'string') continue;
      const normalizedType = normalizeSegmentType(type);
      rawTypes.push(normalizedType);
      if (!isExplicitEmptyTextPlaceholder(item as MessageSegment)) {
        effectiveVideoTypes.push(normalizedType);
      }
    }
    return { rawTypes, effectiveVideoTypes };
  }
  if (typeof message === 'object' && message !== null) {
    const type = (message as { type?: unknown }).type;
    const types = typeof type === 'string' ? [normalizeSegmentType(type)] : [];
    return { rawTypes: types, effectiveVideoTypes: types };
  }
  return { rawTypes: [], effectiveVideoTypes: [] };
}

/**
 * Reject unsupported message combinations before parsers can resolve
 * identities, fetch cards, sign music, or perform any other externally
 * visible work.
 */
export function assertOutboundMessageInput(
  message: JsonValue,
  autoEscape: boolean,
  scene: OutboundMessageScene,
): void {
  const { rawTypes, effectiveVideoTypes } = outboundInputSegmentSummary(message, autoEscape);
  assertVideoSendPolicy(
    effectiveVideoTypes.filter((type) => type === 'video').length,
    effectiveVideoTypes.length,
  );
  const shakeCount = rawTypes.filter((type) => type === 'poke' || type === 'shake').length;
  assertWindowShakeSendPolicy(shakeCount, rawTypes.length, scene);
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
    const isJsonObjectField = type === 'json'
      && (field === 'data' || field === 'config')
      && typeof value === 'object'
      && value !== null
      && !Array.isArray(value);
    if (
      value === undefined
      || value === null
      || typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      || isJsonObjectField
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
  const normalizedType = normalizeSegmentType(type);

  // Ordinary OneBot segment fields are scalar. JSON deliberately accepts its
  // object-valued data/config compatibility fields; every other object/array
  // is rejected before a codec can coerce it and alter caller intent. Forward
  // nodes own nested content but are rejected by their dedicated normal-send
  // branch below; anonymous is rejected regardless of payload.
  if (normalizedType !== 'node' && normalizedType !== 'anonymous') {
    assertScalarSegmentData(normalizedType, data);
  }

  // 纯 OneBot 输入词：可执行的塌缩成 json/face/poke；没有合法发送语义的 node /
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
      // built-in NapCat set. NapCat also treats an id-less platform-labelled
      // segment as custom music data, so presence of id selects platform mode.
      const hasMusicId = data.id !== undefined
        && data.id !== null
        && String(data.id).trim() !== '';
      const hasCustomMusicData = ['url', 'audio', 'title', 'image', 'content']
        .some((field) => Object.prototype.hasOwnProperty.call(data, field));
      const usesCustomMusicData = musicType === 'custom' || (!hasMusicId && hasCustomMusicData);
      if (usesCustomMusicData) {
        requireNonEmptyStringField(normalizedType, data, 'url');
        requireNonEmptyStringField(normalizedType, data, 'audio');
        requireNonEmptyStringField(normalizedType, data, 'title');
      } else if (!hasMusicId) {
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
        if (usesCustomMusicData) {
          postData = {
            type: musicType,
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
      // Legacy OneBot window-shake sugar. The destination guard later limits
      // the normalized poke element to ordinary friend private messages.
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
      // A reply decorates another sendable segment. NapCat-compatible clients
      // treat an unusable reply target as best-effort and still deliver the
      // remaining content; a reply-only message is rejected by parseMessage's
      // final non-empty check below.
      if (normalizedType === 'reply') return null;
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
  if (normalizeSegmentType(seg.type) === 'json' && typeof seg.data === 'string') {
    return { ...topLevel, data: seg.data };
  }
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
      // Some OneBot clients insert empty text between media as a separator.
      // Only the exact empty string is a no-op; malformed and whitespace text
      // must still pass through strict element validation.
      if (isExplicitEmptyTextPlaceholder(seg)) {
        log.debug('ignored explicit empty text placeholder in message segment array');
        continue;
      }
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
