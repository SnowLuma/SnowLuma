import { createLogger } from '@snowluma/common/logger';
import type { MessageElement } from '@snowluma/protocol/events';
import { parseFromCQString } from './helper/cq';
import type { JsonValue } from './types';

const log = createLogger('MsgParser');

export interface ParseMessageOptions {
  resolveReplySequence?: (replyMessageId: number) => number | null;
  resolveReplyMeta?: (replyMessageId: number) => { senderUin: number; time: number; random: number } | null;
  resolveMentionUid?: (targetUin: number) => string | null | Promise<string | null>;
  musicSignUrl?: string;
}

// --- CQ Code parsing ---

export const CQ_REGEX = /\[CQ:([A-Za-z]+)(?:,([^\]]*))?\]/g;

function intOr(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

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
  switch (normalizedType) {
    case 'text': {
      const text = String(data.text ?? '');
      return text ? { type: 'text', text } : null;
    }
    case 'face': {
      const id = intOr(data.id, -1);
      if (id < 0) return null;
      return { type: 'face', faceId: id };
    }
    case 'at': {
      const qq = String(data.qq ?? '').trim();
      if (qq === 'all') {
        return { type: 'at', targetUin: 0, uid: 'all', text: '@全体成员 ' };
      }
      const uin = intOr(qq, 0);
      if (uin <= 0) return null;

      const name = String(data.name ?? data.nickname ?? data.card ?? '').trim();
      let uid = String(data.uid ?? '').trim();
      if (!uid && options?.resolveMentionUid) {
        uid = (await options.resolveMentionUid(uin))?.trim() ?? '';
      }
      const element: MessageElement = { type: 'at', targetUin: uin };
      if (uid) element.uid = uid;
      if (name) element.text = `@${name} `;
      return element;
    }
    case 'reply': {
      const id = intOr(data.id, 0);
      if (id === 0) return null;

      if (options?.resolveReplySequence) {
        const resolved = options.resolveReplySequence(id);
        if (typeof resolved === 'number' && resolved > 0) {
          const element: MessageElement = {
            type: 'reply',
            replySeq: resolved,
            replyMessageId: id  // Keep the original messageId for logging
          };

          // Try to get additional meta info for better reply display
          if (options?.resolveReplyMeta) {
            const meta = options.resolveReplyMeta(id);
            if (meta) {
              element.replySenderUin = meta.senderUin;
              element.replyTime = meta.time;
              element.replyRandom = meta.random;
            }
          }

          return element;
        }
      }

      // Backward-compatible path: allow direct seq reply IDs.
      return id > 0 ? { type: 'reply', replySeq: id } : null;
    }
    case 'image': {
      return {
        type: 'image',
        url: String(data.file ?? data.url ?? data.path ?? data.media ?? ''),
        flash: data.type === 'flash',
        subType: intOr(data.subType, 0),
        summary: data.summary ? String(data.summary) : undefined,
      };
    }
    case 'record': {
      const source = String(data.file ?? data.url ?? data.path ?? data.media ?? '');
      if (!source) return null;
      return {
        type: 'record',
        url: source,
      };
    }
    case 'video': {
      const source = String(data.file ?? data.url ?? data.path ?? data.media ?? '');
      if (!source) return null;
      return {
        type: 'video',
        url: source,
        thumbUrl: data.thumb ? String(data.thumb) : undefined,
      };
    }
    case 'json': {
      return {
        type: 'json',
        text: String(data.data ?? ''),
      };
    }
    case 'xml': {
      return {
        type: 'xml',
        text: String(data.data ?? ''),
        subType: intOr(data.id, 0),
      };
    }
    case 'poke': {
      return {
        type: 'poke',
        faceId: intOr(data.type ?? data.id, 0),
      };
    }
    case 'forward': {
      return {
        type: 'forward',
        resId: String(data.id ?? ''),
      };
    }
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
    case 'markdown': {
      return {
        type: 'markdown',
        text: String(data.content ?? ''),
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
    case 'file': {
      const fileId = String(data.file_id ?? data.fileId ?? '').trim();
      const source = String(data.file ?? data.url ?? data.path ?? '').trim();
      if (!fileId && !source) {
        log.warn('[MsgParser] file segment without file_id or file/url is unsupported');
        return null;
      }
      const fileName = String(data.name ?? data.filename ?? data.fileName ?? '').trim();
      const fileSize = intOr(data.size ?? data.fileSize, 0);
      const md5Hex = String(data.md5 ?? data.md5Hex ?? '').trim();
      const sha1Hex = String(data.sha1 ?? data.sha1Hex ?? '').trim();
      const fileHash = String(data.file_hash ?? data.fileHash ?? '').trim();
      const elem: MessageElement = fileId ? { type: 'file', fileId } : { type: 'file', url: source };
      if (fileName) elem.fileName = fileName;
      if (fileSize > 0) elem.fileSize = fileSize;
      if (md5Hex) elem.md5Hex = md5Hex;
      if (sha1Hex) elem.sha1Hex = sha1Hex;
      if (fileHash) elem.fileHash = fileHash;
      return elem;
    }
    default:
      console.warn(`[MsgParser] unsupported segment type: ${type}`);
      return null;
  }
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
