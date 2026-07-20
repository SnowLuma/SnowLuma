import { createLogger } from '@snowluma/common/logger';
import type {
  MessageElement,
  MessageElementOf,
  MessageElementType,
} from '@snowluma/protocol/events';
import { MessageElementValidationError } from '@snowluma/protocol/element-manifest';
import type { JsonObject } from '../types';
import type { ParseMessageOptions } from '../message-parser';
import type {
  ImageUrlResolver,
  MediaUrlResolver,
  MessageIdResolver,
  MediaSegmentSink,
} from './index';
import { resolveReplyId } from './utils';

// ─────────────────────────────────────────────────────────────────────────
// 消息元素 codec 表（onebot 侧）—— 把「同一种元素」的两个 onebot 方向并到一处：
//   S 收·转  toSegment    MessageElement → OneBot 段
//   P 发·解  fromSegment  OneBot 段 → MessageElement
// 历史上这两向分散在 to-segment.ts 与 message-parser.ts、各写各的，容易一起漂。
// 现在每种元素类型一条 { toSegment?, fromSegment? } 条目，谁少写一向一眼可见，
// 并由 element-manifest 对账测试（onebot 侧）拿本表的键去核对清单。
//
// 第 1 步（收·解，proto 字段分派、异构）与第 4 步（发·打包，protocol 包）不在本表，
// 见 element-manifest.ts 的说明。纯 OneBot 输入糖（骰子/分享/…）也不进表，留在
// message-parser 当前置 normalize。
//
// 每条目由判别类型精确约束：S 读错字段或 P 产出错 discriminant 会在 typecheck 报错。
// ─────────────────────────────────────────────────────────────────────────

const log = createLogger('MsgParser');

/** toSegment（S 收·转）所需的上下文：会话信息 + 各类 URL/媒体解析器。 */
export interface ToSegmentContext {
  isGroup: boolean;
  sessionId: number;
  imageUrlResolver?: ImageUrlResolver | null;
  mediaUrlResolver?: MediaUrlResolver | null;
  messageIdResolver?: MessageIdResolver | null;
  mediaSegmentSink?: MediaSegmentSink | null;
}

// The image segment is the one intentional triangular mapping: an image with
// emoji_id normalizes to a market-face element so it can round-trip as the
// original wire type. Every other codec emits its own discriminant.
type CodecOutput<T extends MessageElementType> = T extends 'image'
  ? MessageElementOf<'image'> | MessageElementOf<'mface'>
  : MessageElementOf<T>;

export interface ElementCodec<T extends MessageElementType = MessageElementType> {
  /** S 收·转：MessageElement → OneBot 段。 */
  toSegment?: (element: MessageElementOf<T>, ctx: ToSegmentContext) => Promise<JsonObject>;
  /** P 发·解：OneBot 段 data → MessageElement（null = 无法构造，parser 会 typed reject）。 */
  fromSegment?: (data: Record<string, unknown>, options?: ParseMessageOptions) => Promise<CodecOutput<T> | null>;
}

type ElementCodecMap = Partial<{
  readonly [T in MessageElementType]: ElementCodec<T>;
}>;

// ── 共享低层工具（原在 message-parser，移来供本表与 message-parser 的输入糖共用）──

export function intOr(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value;
    throw new MessageElementValidationError(
      'INVALID_FIELD',
      `numeric message segment field must be a safe integer, received ${String(value)}`,
    );
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return fallback;
    if (!/^[+-]?\d+$/.test(text)) {
      throw new MessageElementValidationError(
        'INVALID_FIELD',
        `numeric message segment field must contain only an integer, received ${JSON.stringify(value)}`,
      );
    }
    const parsed = Number(text);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new MessageElementValidationError(
    'INVALID_FIELD',
    `numeric message segment field must be a safe integer, received ${String(value)}`,
  );
}

/** Build a market-face (`mface`) element from an OneBot segment's data.
 *  Shared by the dedicated `mface` segment and the `image`-with-`emoji_id`
 *  round-trip path. `emojiId` is the hex GUID the wire builder converts back
 *  to `MarketFace.faceId`. */
export function marketFaceElement(emojiId: string, data: Record<string, unknown>): MessageElementOf<'mface'> {
  return {
    type: 'mface',
    text: String(data.summary ?? data.name ?? ''),
    emojiId,
    emojiPackageId: intOr(data.emoji_package_id ?? data.tab_id, 0),
    emojiKey: String(data.key ?? ''),
  };
}

/**
 * Pick the best loadable source from a media segment's `file` / `url` / `path`
 * / `media` fields.
 *
 * `file` is normally the canonical OneBot field and wins, but it can also be a
 * QQ-internal media id (e.g. `<md5>.png`) that this process cannot resolve to a
 * local path. When a bot framework echoes a received image back (Yunzai et al.
 * resend the original `file=<md5>.ext` together with the download `url`), using
 * `file` makes the send path `statSync` the id as a bogus local path and throw
 * `ENOENT`. So: keep `file` when it is a directly loadable source (inline
 * bytes, a remote url, or a filesystem path with a separator); otherwise, if a
 * real http(s) `url` accompanies it, prefer that. (issue #155)
 */
export function pickMediaSource(data: Record<string, unknown>): string {
  const file = String(data.file ?? '').trim();
  const url = String(data.url ?? '').trim();
  const fallback = file || url || String(data.path ?? '').trim() || String(data.media ?? '').trim();
  if (!file) return fallback;
  // `file` is itself loadable: inline bytes, a remote url, or a path (anything
  // carrying a `/` or `\` separator, incl. file:// and absolute/relative paths).
  if (/^(base64:\/\/|data:|https?:\/\/|file:\/\/)/i.test(file) || /[\\/]/.test(file)) return file;
  // `file` is a bare token (QQ-internal id) — fall back to a real url if present.
  if (/^https?:\/\//i.test(url)) return url;
  return fallback;
}

// ── codec 表：一种元素类型一条，键即 element.type（收·转）/ 段 type（发·解，二者同名）──

export const ELEMENT_CODECS = {
  text: {
    async toSegment(element) {
      return { type: 'text', data: { text: element.text ?? '' } };
    },
    async fromSegment(data) {
      const text = String(data.text ?? '');
      return text ? { type: 'text', text } : null;
    },
  },

  face: {
    async toSegment(element) {
      return { type: 'face', data: { id: String(element.faceId ?? 0) } };
    },
    async fromSegment(data) {
      const id = intOr(data.id, -1);
      if (id < 0) return null;
      return { type: 'face', faceId: id };
    },
  },

  at: {
    async toSegment(element) {
      const qq = (element.uid === 'all' || element.targetUin === 0)
        ? 'all'
        : String(element.targetUin ?? 0);
      return { type: 'at', data: { qq } };
    },
    async fromSegment(data, options) {
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
    },
  },

  reply: {
    async toSegment(element, ctx) {
      const id = resolveReplyId(ctx.isGroup, ctx.sessionId, element.replySeq ?? 0, ctx.messageIdResolver);
      return { type: 'reply', data: { id: String(id) } };
    },
    async fromSegment(data, options) {
      const id = intOr(data.id, 0);
      if (id === 0) return null;
      const meta = options?.resolveReplyMeta?.(id) ?? null;

      if (options?.resolveReplySequence) {
        const resolved = options.resolveReplySequence(id);
        if (typeof resolved === 'number' && resolved > 0) {
          const element: MessageElement = {
            type: 'reply',
            replySeq: resolved,
            replyMessageId: id  // Keep the original messageId for logging
          };

          // Try to get additional meta info for better reply display
          if (meta) {
            element.replySenderUin = meta.senderUin;
            element.replyTime = meta.time;
            element.replyRandom = meta.random;
          }

          return element;
        }
      }

      // The id is known locally, but it came from an OIDB-only/synthetic
      // message and therefore has no QQ server sequence. Treating the opaque
      // OneBot id as a direct sequence would publish a malformed reply.
      if (meta?.sequenceAuthoritative === false) {
        throw new MessageElementValidationError(
          'INVALID_FIELD',
          `reply target ${id} has no authoritative QQ sequence`,
          'reply',
        );
      }

      // Backward-compatible path: allow direct seq reply IDs.
      return id > 0 ? { type: 'reply', replySeq: id } : null;
    },
  },

  image: {
    async toSegment(element, ctx) {
      const url = ctx.imageUrlResolver ? await ctx.imageUrlResolver(element, ctx.isGroup) : (element.imageUrl ?? '');
      const data: JsonObject = {
        url,
        file: element.fileId ?? '',
        sub_type: element.subType ?? 0,
        summary: element.summary ?? '',
      };
      if (element.flash) data.type = 'flash';
      if (ctx.mediaSegmentSink) ctx.mediaSegmentSink('image', element, data, ctx.isGroup, ctx.sessionId);
      return { type: 'image', data };
    },
    async fromSegment(data) {
      // A market face that was surfaced as an `image` (see toSegment) can be
      // echoed straight back: when `emoji_id` is present we rebuild the market
      // face instead of re-uploading the gif as a plain picture.
      const imgEmojiId = String(data.emoji_id ?? '').trim();
      if (imgEmojiId) return marketFaceElement(imgEmojiId, data);
      return {
        type: 'image',
        url: pickMediaSource(data),
        flash: data.type === 'flash',
        subType: intOr(data.sub_type ?? data.subType, 0),
        summary: data.summary ? String(data.summary) : undefined,
      };
    },
  },

  record: {
    async toSegment(element, ctx) {
      const url = ctx.mediaUrlResolver ? await ctx.mediaUrlResolver(element, ctx.isGroup, ctx.sessionId) : (element.url ?? '');
      const data: JsonObject = {
        file: element.fileName ?? element.fileId ?? '',
        url,
      };
      if (ctx.mediaSegmentSink) ctx.mediaSegmentSink('record', element, data, ctx.isGroup, ctx.sessionId);
      return { type: 'record', data };
    },
    async fromSegment(data) {
      const source = pickMediaSource(data);
      if (!source) return null;
      return {
        type: 'record',
        url: source,
      };
    },
  },

  video: {
    async toSegment(element, ctx) {
      const url = ctx.mediaUrlResolver ? await ctx.mediaUrlResolver(element, ctx.isGroup, ctx.sessionId) : (element.url ?? '');
      const data: JsonObject = {
        file: element.fileName ?? element.fileId ?? '',
        url,
      };
      if (ctx.mediaSegmentSink) ctx.mediaSegmentSink('video', element, data, ctx.isGroup, ctx.sessionId);
      return { type: 'video', data };
    },
    async fromSegment(data) {
      const source = pickMediaSource(data);
      if (!source) return null;
      return {
        type: 'video',
        url: source,
        thumbUrl: data.thumb ? String(data.thumb) : undefined,
      };
    },
  },

  json: {
    async toSegment(element) {
      return { type: 'json', data: { data: element.text ?? '' } };
    },
    async fromSegment(data) {
      const text = data.data;
      if (typeof text !== 'string' || !text.trim()) {
        throw new MessageElementValidationError(
          'INVALID_FIELD',
          'message segment "json" field "data" must be a non-empty JSON string',
          'json',
          'data',
        );
      }
      return {
        type: 'json',
        text,
      };
    },
  },

  xml: {
    async toSegment(element) {
      return {
        type: 'xml',
        data: {
          data: element.text ?? '',
          resid: element.subType ?? 35,
        },
      };
    },
    async fromSegment(data) {
      return {
        type: 'xml',
        text: String(data.data ?? ''),
        subType: intOr(data.resid ?? data.id, 0),
      };
    },
  },

  file: {
    async toSegment(element, ctx) {
      const url = ctx.mediaUrlResolver ? await ctx.mediaUrlResolver(element, ctx.isGroup, ctx.sessionId) : (element.url ?? '');
      const fileName = element.fileName ?? '';
      const fileSize = element.fileSize ?? 0;
      const fileId = element.fileId ?? '';
      return {
        type: 'file',
        data: {
          // NapCat/LLOneBot-style canonical fields — most downstream
          // OneBot adapters read these (`file`/`file_id`/`file_size`).
          file: fileName,
          file_id: fileId,
          file_size: fileSize,
          // Legacy SnowLuma field names, kept for backward compat with
          // any consumer that already reads name/size/id.
          name: fileName,
          size: fileSize,
          id: fileId,
          url,
          file_hash: element.fileHash ?? '',
        },
      };
    },
    async fromSegment(data) {
      const fileId = String(data.file_id ?? data.fileId ?? data.id ?? '').trim();
      // Reuse the media-source rule: a bare `file` token is commonly only the
      // display filename/internal id and must not mask a loadable HTTP URL.
      const source = pickMediaSource(data);
      if (!fileId && !source) {
        log.warn('[MsgParser] file segment without file_id or file/url is unsupported');
        return null;
      }
      const fileName = String(data.name ?? data.filename ?? data.fileName ?? '').trim();
      const fileSize = intOr(data.file_size ?? data.size ?? data.fileSize, 0);
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
    },
  },

  mface: {
    async toSegment(element) {
      // Unify market faces (商城表情) to an `image` segment so OneBot clients
      // that don't special-case `mface` still render the sticker, while the
      // `emoji_id`/`emoji_package_id`/`key` markers let aware clients (and our
      // own send path) reproduce it as a real market face. Mirrors NapCat's
      // marketFaceElement → image conversion. The gxh URL is a self-contained
      // external link (no rkey), so we set it directly and skip mediaSegmentSink.
      const emojiId = element.emojiId ?? '';
      const dir = emojiId.slice(0, 2);
      const url = emojiId
        ? `https://gxh.vip.qq.com/club/item/parcel/item/${dir}/${emojiId}/raw300.gif`
        : '';
      return {
        type: 'image',
        data: {
          file: emojiId ? `${dir}-${emojiId}.gif` : '',
          url,
          summary: element.text ?? '',
          sub_type: 0,
          emoji_id: emojiId,
          emoji_package_id: element.emojiPackageId ?? 0,
          key: element.emojiKey ?? '',
        },
      };
    },
    async fromSegment(data) {
      // Market face (商城表情). emoji_id is the hex GUID; without it we can't
      // construct the wire element, so drop the segment.
      const emojiId = String(data.emoji_id ?? '').trim();
      if (!emojiId) {
        log.warn('[MsgParser] mface segment without emoji_id is unsupported');
        return null;
      }
      return marketFaceElement(emojiId, data);
    },
  },

  poke: {
    async toSegment(element) {
      return {
        type: 'poke',
        data: {
          type: element.subType ?? 0,
        },
      };
    },
    async fromSegment(data) {
      if (data.type === undefined && data.id === undefined) return null;
      return {
        type: 'poke',
        subType: intOr(data.type ?? data.id, 0),
      };
    },
  },

  // 闪传文件 (flash transfer) — receive-only. Decoded from an older-client
  // richui markdown card (#199/#200). Sending uses the send_flash_msg action,
  // so there is no fromSegment.
  flash_file: {
    async toSegment(element) {
      return {
        type: 'flash_file',
        data: {
          title: element.fileName ?? '',
          file_set_id: element.filesetId ?? '',
          scene_type: element.sceneType ?? 0,
        },
      };
    },
  },

  forward: {
    async toSegment(element) {
      return {
        type: 'forward',
        data: { id: element.resId ?? '' },
      };
    },
    async fromSegment(data) {
      return {
        type: 'forward',
        resId: String(data.id ?? ''),
      };
    },
  },

  markdown: {
    // 收侧（S）无对应，仅发·解存在。
    async fromSegment(data) {
      return {
        type: 'markdown',
        text: String(data.content ?? ''),
      };
    },
  },
} satisfies ElementCodecMap;

/**
 * Dynamic lookup boundary. Each table entry is checked against its precise
 * discriminant above; callers with a runtime type receive the safe union view.
 */
export function getElementCodec(type: string): ElementCodec | undefined {
  if (!Object.hasOwn(ELEMENT_CODECS, type)) return undefined;
  return (ELEMENT_CODECS as unknown as Record<string, ElementCodec>)[type];
}
