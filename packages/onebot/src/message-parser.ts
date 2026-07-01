import { createLogger } from '@snowluma/common/logger';
import type { MessageElement } from '@snowluma/protocol/events';
import { parseFromCQString } from './helper/cq';
import { ELEMENT_CODECS, intOr } from './event-converter/element-codecs';
import type { JsonValue } from './types';

const log = createLogger('MsgParser');

export interface ParseMessageOptions {
  resolveReplySequence?: (replyMessageId: number) => number | null;
  resolveReplyMeta?: (replyMessageId: number) => { senderUin: number; time: number; random: number } | null;
  resolveMentionUid?: (targetUin: number) => string | null | Promise<string | null>;
  resolveContactArk?: (contactType: string, contactId: number) => string | null | Promise<string | null>;
  musicSignUrl?: string;
}

// --- CQ Code parsing ---

export const CQ_REGEX = /\[CQ:([A-Za-z]+)(?:,([^\]]*))?\]/g;

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
    (item) => typeof item === 'object' && item !== null && 'type' in item
  );
}

export async function segmentToElement(type: string, data: Record<string, unknown>, options?: ParseMessageOptions): Promise<MessageElement | null> {
  const normalizedType = type.toLowerCase();

  // 纯 OneBot 输入糖：不是某种真实消息元素，只是被塌缩成 json/face/poke 的输入
  // 便利（或 forward 组装用的中间 node），无收侧对应、无专属 wire 形态，故不进
  // codec 表 —— 在这里前置处理。真实元素（收发同名）走下方的 ELEMENT_CODECS。
  switch (normalizedType) {
    case 'node': {
      // Fake forward node segment — store the raw data for later processing
      // The content field may be a segment array, a single segment, or a CQ string
      const name = String(data.nickname ?? data.name ?? '');
      return {
        type: 'node',
        targetUin: intOr(data.user_id ?? data.uin, 0),
        text: name,
        // Raw content is stored as JSON string in resId for later processing
        resId: JSON.stringify(data.content ?? ''),
      };
    }
    case 'share': {
      // Link share — map to json card message
      const url = String(data.url ?? '');
      const title = String(data.title ?? '');
      const content = String(data.content ?? '');
      const image = String(data.image ?? '');
      const jsonData = JSON.stringify({
        app: 'com.tencent.structmsg',
        view: 'news',
        prompt: title,
        meta: { news: { title, desc: content, jumpUrl: url, preview: image } },
      });
      return { type: 'json', text: jsonData };
    }
    case 'music': {
      // Music share — uses external signing service (NapCat-compatible)
      const musicType = String(data.type ?? '');
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
        return { type: 'json', text: musicJson };
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
        return { type: 'json', text: jsonData };
      }
    }
    case 'location': {
      // Location — map to json card
      const lat = String(data.lat ?? '');
      const lon = String(data.lon ?? '');
      const title = String(data.title ?? '位置');
      const content = String(data.content ?? `${lat},${lon}`);
      const jsonData = JSON.stringify({
        app: 'com.tencent.map',
        view: 'LocationShare',
        prompt: `[位置]${title}`,
        meta: { Location: { lat, lng: lon, title, address: content } },
      });
      return { type: 'json', text: jsonData };
    }
    case 'contact': {
      // Contact card — map to json card
      const contactType = String(data.type ?? 'qq');
      const contactId = String(data.id ?? '');
      const numericId = intOr(contactId, 0);
      const normalizedContactType = contactType.trim().toLowerCase();
      if (numericId > 0 && options?.resolveContactArk && (normalizedContactType === 'qq' || normalizedContactType === 'group')) {
        const ark = await options.resolveContactArk(contactType, numericId);
        if (!ark) throw new Error(`contact ark unavailable for ${contactType}:${numericId}`);
        return { type: 'json', text: ark };
      }
      const jsonData = JSON.stringify({
        app: 'com.tencent.contact.lua',
        view: 'contact',
        prompt: `[推荐${contactType === 'group' ? '群' : '好友'}]`,
        meta: { contact: { type: contactType, id: contactId } },
      });
      return { type: 'json', text: jsonData };
    }
    case 'rps': {
      // Rock-paper-scissors — map to dice-like face
      return { type: 'face', faceId: 359 };
    }
    case 'dice': {
      // Dice — map to dice face
      return { type: 'face', faceId: 358 };
    }
    case 'shake': {
      // Window shake — map to poke
      return { type: 'poke', faceId: 1 };
    }
    case 'anonymous': {
      // Anonymous flag — ignored during send, the protocol handles anonymity
      return null;
    }
  }

  // 真实元素（P 发·解，段 type 与 element.type 同名）：查 codec 表。
  // 见 event-converter/element-codecs.ts。
  const codec = ELEMENT_CODECS[normalizedType];
  if (codec?.fromSegment) return codec.fromSegment(data, options);

  console.warn(`[MsgParser] unsupported segment type: ${type}`);
  return null;
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
    if (autoEscape) {
      return message ? [{ type: 'text', text: message }] : [];
    }
    return parseFromCQString(message, options);
  }

  if (isSegmentArray(message)) {
    const elements: MessageElement[] = [];
    for (const seg of message) {
      const data = segmentPayload(seg);
      const elem = await segmentToElement(seg.type, data, options);
      if (elem) elements.push(elem);
    }
    return elements;
  }

  // Single segment object
  if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
    const seg = message as unknown as MessageSegment;
    if (seg.type) {
      const data = segmentPayload(seg);
      const elem = await segmentToElement(seg.type, data, options);
      return elem ? [elem] : [];
    }
  }

  return [];
}
