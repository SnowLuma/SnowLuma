import type { JsonValue } from '@snowluma/common/json';
import { createLogger } from '@snowluma/common/logger';
import { RequestUtil, cookieToString, getBknFromCookie } from './request-util';

const log = createLogger('Bridge.Web');

// ─────────────── raw shapes from taotao.qzone.qq.com ───────────────
// These mirror the `emotion_cgi_msglist_v6` response. The endpoint is a
// legacy Qzone CGI: field names are stable across years (the community
// libs SmartHypercube/Qzone-API and cw1997/QzoneUtil rely on the same
// set), but the server occasionally adds fields and may wrap the body in
// a JSONP callback — both handled below. Precise field coverage should be
// re-confirmed against a live capture when extending this (same
// maintenance posture as the group-album / group-signin web helpers).

interface RawPic {
  url1?: string;
  url2?: string;
  url3?: string;
  smallurl?: string;
}

interface RawEmotion {
  tid?: string;
  content?: string;
  created_time?: number;
  cmtnum?: number;
  secret?: number;
  pic?: RawPic[];
}

interface RawMsgListResponse {
  code?: number;
  subcode?: number;
  message?: string;
  total?: number;
  msglist?: RawEmotion[] | null;
}

// ─────────────── OneBot-facing shapes ───────────────

/** One 说说 (Qzone emotion/feed) in a normalised, OneBot-friendly form. */
export interface QzoneEmotion {
  [key: string]: JsonValue;
  /** Feed id — the handle for delete/comment/like on this 说说. */
  tid: string;
  content: string;
  /** Unix seconds the 说说 was posted. */
  time: number;
  /** Number of comments on the 说说. */
  comment_num: number;
  /** Private (仅自己可见) flag. */
  is_private: boolean;
  /** Picture URLs (largest available variant per picture). */
  images: string[];
}

export interface QzoneMsgListResult {
  [key: string]: JsonValue;
  /** Total number of 说说 the account has (not the page size). */
  total: number;
  msglist: QzoneEmotion[];
}

/**
 * Parse a Qzone CGI body that may be raw JSON or a JSONP callback wrapper
 * (`_Callback({...});` / `callback({...})`). We slice from the first `{`
 * to the last `}` and JSON.parse that — robust to either form without
 * pinning the callback name, which Qzone varies. Throws if no object body
 * is present (e.g. an HTML error page), which the caller turns into a
 * failed response rather than a silent empty list.
 */
export function parseQzoneJson<T>(text: string): T {
  const s = text.trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('invalid response from qzone api');
  }
  return JSON.parse(s.slice(start, end + 1)) as T;
}

/** Pick the largest picture URL variant a feed picture offers. */
function pickPicUrl(pic: RawPic): string | undefined {
  return pic.url3 || pic.url2 || pic.url1 || pic.smallurl || undefined;
}

/** Pure transform from the raw CGI response into the OneBot list. */
export function mapMsgList(data: RawMsgListResponse): QzoneMsgListResult {
  const list = data.msglist ?? [];
  return {
    total: Number(data.total ?? list.length),
    msglist: list.map((e) => ({
      tid: String(e.tid ?? ''),
      content: e.content ?? '',
      time: Number(e.created_time ?? 0),
      comment_num: Number(e.cmtnum ?? 0),
      is_private: Number(e.secret ?? 0) !== 0,
      images: (e.pic ?? []).map(pickPicUrl).filter((u): u is string => !!u),
    })),
  };
}

/**
 * Fetch a 说说 (Qzone emotion/feed) list via the taotao.qzone.qq.com web
 * API, proxied through h5.qzone.qq.com — the same cookie/g_tk plumbing the
 * group-album helper uses. Defaults to the bot's own space; `targetUin`
 * can name any space the bot may view.
 *
 * Errors PROPAGATE: a transport failure, a non-zero `code` (Qzone's own
 * error envelope, e.g. auth/permission), or a missing `msglist` (the body
 * an expired cookie produces) all throw — we do NOT swallow them to an
 * empty list, because that would make a broken cookie indistinguishable
 * from a genuinely empty space. A real empty space returns `msglist: []`,
 * which maps to an empty list with the correct `total`. Mirrors the
 * group-signin helper's throw-on-auth-failure contract.
 */
export async function getQzoneMsgList(
  cookieObject: Record<string, string>,
  targetUin: string,
  pos = 0,
  num = 20,
): Promise<QzoneMsgListResult> {
  if (!cookieObject || typeof cookieObject !== 'object') {
    throw new Error('cookieObject is required');
  }

  const bkn = getBknFromCookie(cookieObject);
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6?${new URLSearchParams(
    {
      uin: targetUin,
      ftype: '0',
      sort: '0',
      pos: String(pos),
      num: String(num),
      replynum: '100',
      g_tk: bkn,
      callback: '_preloadCallback',
      code_version: '1',
      format: 'jsonp',
      need_private_comment: '1',
    },
  ).toString()}`;

  const text = await RequestUtil.HttpGetText(url, 'GET', '', {
    Cookie: cookieToString(cookieObject),
  });
  const data = parseQzoneJson<RawMsgListResponse>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    log.warn('getQzoneMsgList: non-zero code (uin=%s) code=%d msg=%s', targetUin, data.code, data.message);
    throw new Error(`qzone msglist failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  if (!Array.isArray(data.msglist)) {
    log.warn('getQzoneMsgList: no msglist in response (uin=%s) — likely auth/cookie failure', targetUin);
    throw new Error('无法获取空间说说列表');
  }

  return mapMsgList(data);
}

// ─────────────── 好友动态 (friend feeds) — feeds3_html_more ───────────────
// The friend-feed CGI returns each feed as a pre-rendered HTML blob plus a
// few structured fields. We surface the stable structured fields and pass
// the `html` through verbatim (deep HTML→segment parsing is out of scope —
// callers that want it parse the blob themselves). Exact field names /
// pagination cursor to be re-confirmed against a live capture, same posture
// as the msglist helper.

interface RawFeedItem {
  uin?: number | string;
  nickname?: string;
  abstime?: number | string;
  appid?: number | string;
  typeid?: number | string;
  key?: string;
  feedskey?: string;
  html?: string;
}

interface RawFeedsResponse {
  code?: number;
  subcode?: number;
  message?: string;
  data?: {
    data?: RawFeedItem[] | null;
    hasmore?: number | string;
  };
}

/** One friend-feed entry in a normalised, OneBot-friendly form. */
export interface QzoneFeed {
  [key: string]: JsonValue;
  /** Author uin. */
  uin: number;
  nickname: string;
  /** Unix seconds the feed was posted. */
  time: number;
  /** Qzone app id (311 = 说说, 4 = 相册, …). */
  appid: number;
  /** Feed key — the handle Qzone uses to address this feed. */
  key: string;
  /** Pre-rendered HTML blob for the feed (passed through verbatim). */
  html: string;
}

export interface QzoneFeedsResult {
  [key: string]: JsonValue;
  feeds: QzoneFeed[];
  /** Whether the server reports more pages after this one. */
  has_more: boolean;
}

/** Pure transform from the raw feeds response into the OneBot list. */
export function mapFeeds(data: RawFeedsResponse): QzoneFeedsResult {
  const list = data.data?.data ?? [];
  return {
    feeds: list.map((f) => ({
      uin: Number(f.uin ?? 0),
      nickname: f.nickname ?? '',
      time: Number(f.abstime ?? 0),
      appid: Number(f.appid ?? 0),
      key: String(f.key ?? f.feedskey ?? ''),
      html: f.html ?? '',
    })),
    has_more: Number(data.data?.hasmore ?? 0) !== 0,
  };
}

/**
 * Fetch the 好友动态 (friend-feed) list via ic2.qzone.qq.com's
 * feeds3_html_more CGI. `pageNum` is 1-based; `count` is the page size.
 * Same cookie/g_tk plumbing and throw-on-auth-failure contract as
 * {@link getQzoneMsgList}: a missing `data.data` array means the cookie/
 * auth failed and throws, whereas a genuinely empty feed (`data.data: []`)
 * maps to an empty list.
 */
export async function getQzoneFeeds(
  cookieObject: Record<string, string>,
  selfUin: string,
  pageNum = 1,
  count = 10,
): Promise<QzoneFeedsResult> {
  if (!cookieObject || typeof cookieObject !== 'object') {
    throw new Error('cookieObject is required');
  }

  const bkn = getBknFromCookie(cookieObject);
  const url = `https://ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?${new URLSearchParams(
    {
      uin: selfUin,
      scope: '0',
      view: '1',
      filter: 'all',
      flag: '1',
      applist: 'all',
      pagenum: String(pageNum),
      count: String(count),
      aisortEndTime: '0',
      aisortOffset: '0',
      aisortBeginTime: '0',
      begintime: '0',
      format: 'json',
      g_tk: bkn,
      useutf8: '1',
      outputhtmlfeed: '1',
    },
  ).toString()}`;

  const text = await RequestUtil.HttpGetText(url, 'GET', '', {
    Cookie: cookieToString(cookieObject),
  });
  const data = parseQzoneJson<RawFeedsResponse>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    log.warn('getQzoneFeeds: non-zero code (uin=%s) code=%d msg=%s', selfUin, data.code, data.message);
    throw new Error(`qzone feeds failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  if (!Array.isArray(data.data?.data)) {
    log.warn('getQzoneFeeds: no data array in response (uin=%s) — likely auth/cookie failure', selfUin);
    throw new Error('无法获取空间好友动态');
  }

  return mapFeeds(data);
}
