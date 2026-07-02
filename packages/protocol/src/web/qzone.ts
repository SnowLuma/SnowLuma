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
 * (`_Callback({...});` / `callback({...})`). We first attempt to slice from
 * the first `{` to the last `}`, when failed attempt from the first `back({`
 * to the last `})` and JSON.parse that — robust to either form without
 * pinning the callback name, which Qzone varies. Throws if no object body
 * is present (e.g. an HTML error page), which the caller turns into a
 * failed response rather than a silent empty list.
 */
export function parseQzoneJson<T>(text: string): T {
  const s = text.trim();
  try {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(s.slice(start, end + 1)) as T;
    }
  } catch {

  }
  const start = s.indexOf('back({');
  const end = s.lastIndexOf('})');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('invalid response from qzone api');
  }
  return JSON.parse(s.slice(start + 5, end + 1)) as T;
}

/**
 * Parse the JavaScript OBJECT-LITERAL payload of a Qzone JSONP feeds response
 * WITHOUT executing it. feeds3_html_more returns `_preloadCallback({ … })` where
 * the `data` value uses unquoted keys, single-quoted strings, `\xNN` escapes and
 * literal `undefined`s — it is meant to be eval'd by the browser callback, so
 * JSON.parse chokes on it. We ran the alternatives to ground: no param combo
 * (outputhtmlfeed/format) makes the CGI emit real JSON, and feeds are pure
 * remote H5 (absent from the native client), so there is no cleaner endpoint.
 * Rather than eval remote-controlled content (a `vm` sandbox is not a security
 * boundary — a tampered body escapes it to RCE), we recursively DESCEND the
 * literal as data: it can only ever produce a value, never run code.
 *
 * Handles the subset the CGI emits: objects (unquoted or quoted keys), arrays
 * (incl. `undefined`/elided holes), single/double-quoted strings with JS escapes
 * (`\xNN`, `\uNNNN`, `\/`, …), numbers and `true|false|null|undefined`.
 * `__proto__` keys are dropped (no prototype pollution).
 */
function parseJsLiteral(src: string): unknown {
  let i = 0;
  const n = src.length;
  const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
  const skipWs = (): void => { while (i < n && isWs(src[i]!)) i++; };

  function parseString(quote: string): string {
    i++; // opening quote
    let out = '';
    while (i < n) {
      const c = src[i]!;
      if (c === '\\') {
        const e = src[i + 1];
        if (e === 'x') { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)); i += 4; continue; }
        if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
        const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
        out += e !== undefined ? (simple[e] ?? e) : ''; // \/ → /, \' → ', unknown → the char
        i += 2;
        continue;
      }
      if (c === quote) { i++; return out; }
      out += c;
      i++;
    }
    throw new Error('unterminated string in qzone feeds payload');
  }

  function parseKey(): string {
    skipWs();
    const c = src[i];
    if (c === '"' || c === "'") return parseString(c);
    let s = '';
    while (i < n && /[A-Za-z0-9_$]/.test(src[i]!)) { s += src[i]; i++; }
    if (!s) throw new Error('expected object key in qzone feeds payload');
    return s;
  }

  function parseObject(): Record<string, unknown> {
    i++; // {
    const obj: Record<string, unknown> = {};
    skipWs();
    if (src[i] === '}') { i++; return obj; }
    for (;;) {
      const key = parseKey();
      skipWs();
      if (src[i] !== ':') throw new Error('expected ":" in qzone feeds payload');
      i++;
      const value = parseValue();
      if (key !== '__proto__') obj[key] = value;
      skipWs();
      const ch = src[i];
      if (ch === ',') { i++; skipWs(); if (src[i] === '}') { i++; return obj; } continue; }
      if (ch === '}') { i++; return obj; }
      throw new Error('expected "," or "}" in qzone feeds payload');
    }
  }

  function parseArray(): unknown[] {
    i++; // [
    const arr: unknown[] = [];
    skipWs();
    if (src[i] === ']') { i++; return arr; }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      const ch = src[i];
      if (ch === ',') { i++; skipWs(); if (src[i] === ']') { i++; return arr; } continue; }
      if (ch === ']') { i++; return arr; }
      throw new Error('expected "," or "]" in qzone feeds payload');
    }
  }

  function parseValue(): unknown {
    skipWs();
    const c = src[i];
    if (c === undefined) throw new Error('unexpected end of qzone feeds payload');
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"' || c === "'") return parseString(c);
    let token = '';
    while (i < n && !/[,}\]:\s]/.test(src[i]!)) { token += src[i]; i++; }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (token === 'undefined') return undefined;
    if (token !== '') { const num = Number(token); if (!Number.isNaN(num)) return num; }
    throw new Error('unexpected token in qzone feeds payload: ' + token.slice(0, 20));
  }

  return parseValue();
}

/**
 * Extract the object a Qzone feeds JSONP body hands to its callback, parsed as
 * data (never executed — see {@link parseJsLiteral}). Slices from the first `{`
 * (the callback argument) and parses one balanced value; trailing `);` is
 * ignored. Throws if the payload is not an object.
 */
export function parseQzoneCallback<T>(text: string): T {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('invalid feeds response from qzone api');
  const value = parseJsLiteral(text.slice(start));
  if (value === null || typeof value !== 'object') {
    throw new Error('invalid feeds response from qzone api');
  }
  return value as T;
}

function assertRichParams(richType?: number, richval?: string): void {
  const hasRichType = richType !== undefined;
  const hasRichval = richval !== undefined && richval.trim() !== '';
  if (hasRichType !== hasRichval) {
    throw new Error('richType and richval must be provided together');
  }
  if (richType !== undefined && (!Number.isInteger(richType) || richType < 1)) {
    throw new Error('richType must be a positive integer');
  }
}

function normalizeQzoneImageBase64(input: string): string {
  let text = input.trim();
  if (/^base64:\/\//i.test(text)) {
    text = text.slice(9).trim();
  }
  if (/^data:/i.test(text)) {
    const comma = text.indexOf(',');
    if (comma === -1) {
      throw new Error('imageBase64 data URI is missing base64 payload');
    }
    text = text.slice(comma + 1);
  }

  const compact = text.replace(/ /g, '+').replace(/[\r\n\t]/g, '');
  if (!compact) {
    throw new Error('imageBase64 is required');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error('imageBase64 is not valid base64');
  }
  const firstPadding = compact.indexOf('=');
  if (firstPadding !== -1 && /[^=]/.test(compact.slice(firstPadding))) {
    throw new Error('imageBase64 is not valid base64');
  }

  const unpadded = compact.replace(/=+$/, '');
  const remainder = unpadded.length % 4;
  if (remainder === 1) {
    throw new Error('imageBase64 is not valid base64');
  }
  const base64 = unpadded + '='.repeat((4 - remainder) % 4);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) {
    throw new Error('imageBase64 is empty');
  }
  return base64;
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
  log.trace('getQzoneMsgList raw body (uin=%s): %s', targetUin, text);
  const data = parseQzoneJson<RawMsgListResponse>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    log.warn('getQzoneMsgList: non-zero code (uin=%s) code=%d msg=%s', targetUin, data.code, data.message);
    throw new Error(`qzone msglist failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  if (!Array.isArray(data.msglist)) {
    log.warn('getQzoneMsgList: no msglist in response (uin=%s) — likely auth/cookie failure or unverified response shape; body head=%s', targetUin, text.slice(0, 300));
    throw new Error(`无法获取空间说说列表（响应结构异常）: ${text.slice(0, 200)}`);
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
  // The CGI pads the array with trailing `undefined`/null holes — drop them.
  const list = (data.data?.data ?? []).filter((f): f is RawFeedItem => !!f);
  return {
    feeds: list.map((f) => ({
      uin: Number(f.uin ?? 0),
      nickname: f.nickname ?? '',
      time: Number(f.abstime ?? 0),
      appid: Number(f.appid ?? 0),
      // `key` is the per-feed handle; `feedskey` is its older alias on some
      // feed types. They name the same per-feed identifier here (NOT the
      // list-level next-page cursor, which lives on data.* not the item).
      key: String(f.key ?? f.feedskey ?? ''),
      html: f.html ?? '',
    })),
    has_more: Number(data.data?.hasmore ?? 0) !== 0,
  };
}

/**
 * Fetch the 好友动态 (friend-feed) list via the feeds3_html_more CGI on
 * ic2.qzone.qq.com, routed through the h5.qzone.qq.com proxy gateway — the
 * same gateway {@link getQzoneMsgList} and group-album use, because the
 * qzone.qq.com cookie jar only authenticates against the proxy origin
 * (hitting ic2 directly fails the referer/same-origin check). Body is
 * requested as JSONP (`format=jsonp` + a callback) and parsed with the
 * shared tolerant parser, matching slice-1's contract exactly.
 *
 * `pageNum` is 1-based; `count` is the page size. PAGINATION CAVEAT: this
 * CGI's reliable deep-pagination is driven by a time cursor
 * (begintime/externparam/usertime carried forward from the previous page),
 * which we do not yet thread — so `pageNum` is dependable for the first
 * page and `has_more` only signals whether more exist, not a stable
 * page-2 fetch. Cursor pagination is deferred until a live capture.
 *
 * Same throw-on-auth-failure contract as {@link getQzoneMsgList}: a missing
 * `data.data` array means the cookie/auth failed and throws, whereas a
 * genuinely empty feed (`data.data: []`) maps to an empty list.
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
  const url = `https://h5.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?${new URLSearchParams(
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
      g_tk: bkn,
      callback: '_preloadCallback',
      format: 'jsonp',
      useutf8: '1',
      outputhtmlfeed: '1',
    },
  ).toString()}`;

  const text = await RequestUtil.HttpGetText(url, 'GET', '', {
    Cookie: cookieToString(cookieObject),
  });
  log.trace('getQzoneFeeds raw body (uin=%s): %s', selfUin, text);
  // feeds3_html_more's payload is a JS object literal, not JSON — parse it as
  // inert data (see parseQzoneCallback; never executed) rather than JSON.parse.
  const data = parseQzoneCallback<RawFeedsResponse>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    log.warn('getQzoneFeeds: non-zero code (uin=%s) code=%d msg=%s', selfUin, data.code, data.message);
    throw new Error(`qzone feeds failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  if (!Array.isArray(data.data?.data)) {
    log.warn('getQzoneFeeds: no data array in response (uin=%s) — likely auth/cookie failure or unverified response shape; body head=%s', selfUin, text.slice(0, 300));
    throw new Error(`无法获取空间好友动态（响应结构异常）: ${text.slice(0, 200)}`);
  }

  return mapFeeds(data);
}

// ─────────────── 发说说 (publish emotion) — emotion_cgi_publish_v6 ───────────────
// First write path. Text-only here; 带图 (image) publishing layers an
// upload step on top in a later slice. Same cookie/g_tk plumbing + proxy
// gateway + tolerant parse as the read paths. WRITE OP — callers should
// rate-limit (publishing is an active action and Qzone风控s high frequency,
// same as sending messages).

interface RawPublishResponse {
  code?: number;
  subcode?: number;
  message?: string;
  // The publish_v6 SUCCESS envelope names the new feed id `t1_tid` and the
  // post time `t1_time` (the latter arrives as a STRING). `tid`/`now` are
  // kept as defensive fallbacks for alternate client builds, but `t1_tid`
  // is the real primary — reading `tid` alone false-throws on every success.
  t1_tid?: string;
  t1_time?: string;
  tid?: string;
  now?: number;
}

export type QzoneUgcRight = 1 | 4 | 16 | 64 | 128;

/** Result of publishing a 说说. */
export interface QzonePublishResult {
  [key: string]: JsonValue;
  /** The new feed's id — the handle for a later delete/comment/like. */
  tid: string;
  /** Unix seconds the 说说 was published. */
  time: number;
}

const QZONE_UGC_RIGHTS = new Set<number>([1, 4, 16, 64, 128]);

function normalizeQzoneUgcRight(ugcRight: number): QzoneUgcRight {
  if (!QZONE_UGC_RIGHTS.has(ugcRight)) {
    throw new Error('ugc_right must be one of 1, 4, 16, 64, 128');
  }
  return ugcRight as QzoneUgcRight;
}

function normalizeTargetUins(targetUins?: string): string {
  const raw = (targetUins ?? '').trim();
  if (!raw) return '';

  const seen = new Set<string>();
  for (const part of raw.split('|')) {
    const uin = part.trim();
    if (!uin) continue;
    if (!/^\d+$/.test(uin)) {
      throw new Error('target_uins must contain QQ numbers separated by |');
    }
    seen.add(uin);
  }
  return [...seen].join('|');
}

/**
 * Publish a 说说 via taotao.qzone.qq.com's emotion_cgi_publish_v6 CGI
 * (proxied through h5.qzone.qq.com). POSTs a form-urlencoded body with
 * `g_tk` in the query, on the bot's own space (`hostUin`).
 *
 * `richType` / `richval`: for image posts, set `richType=1` and pass the
 * richval string(s) from {@link uploadQzoneImage} (multi-image: join with
 * `\t`). Omit both for text-only posts.
 *
 * Errors PROPAGATE: a transport failure, a non-zero Qzone `code` (its error
 * envelope, e.g. content rejected / rate-limited), or a success body that
 * carries no `tid` all throw — we never report a publish as succeeded
 * without the server-assigned feed id.
 */
export async function publishQzoneMsg(
  cookieObject: Record<string, string>,
  hostUin: string,
  content: string,
  richType?: number,
  richval?: string,
  ugcRight = 1,
  targetUins?: string,
): Promise<QzonePublishResult> {
  if (!cookieObject || typeof cookieObject !== 'object') {
    throw new Error('cookieObject is required');
  }
  if (!content) {
    throw new Error('content is required');
  }
  assertRichParams(richType, richval);

  const right = normalizeQzoneUgcRight(ugcRight);
  const effectiveTargetUins = right === 16 || right === 128 ? normalizeTargetUins(targetUins) : '';
  if ((right === 16 || right === 128) && !effectiveTargetUins) {
    throw new Error('target_uins is required when ugc_right is 16 or 128');
  }

  const bkn = getBknFromCookie(cookieObject);
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${bkn}`;
  const bodyParams = new URLSearchParams({
    syn_tweet_verson: '1',
    paramstr: '1',
    pic_template: '',
    richtype: richType !== undefined ? String(richType) : '',
    richval: richval ?? '',
    special_url: '',
    subrichtype: '',
    con: content,
    feedversion: '1',
    ver: '1',
    ugc_right: String(right),
    to_sign: '0',
    who: '1',
    hostuin: hostUin,
    code_version: '1',
    format: 'json',
    qzreferrer: `https://user.qzone.qq.com/${hostUin}`,
  });
  if (effectiveTargetUins) bodyParams.set('allow_uins', effectiveTargetUins);
  const body = bodyParams.toString();

  const text = await RequestUtil.HttpGetText(url, 'POST', body, {
    Cookie: cookieToString(cookieObject),
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  const data = parseQzoneJson<RawPublishResponse>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    log.warn('publishQzoneMsg: non-zero code (uin=%s) code=%d msg=%s', hostUin, data.code, data.message);
    throw new Error(`qzone publish failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  const tid = data.t1_tid ?? data.tid;
  if (!tid) {
    log.warn('publishQzoneMsg: no tid in response (uin=%s) — publish likely rejected', hostUin);
    throw new Error('发表说说失败：响应缺少 tid');
  }

  // t1_time is a string on the wire; Number() coerces it (and the `now`
  // numeric fallback) uniformly.
  return { tid: String(tid), time: Number(data.t1_time ?? data.now ?? 0) };
}

// ─────────────── 删说说 (delete emotion) — emotion_cgi_delete_v6 ───────────────
// Deletes one of the bot's OWN 说说 by tid. Same form-POST mechanics as
// publish. No positive payload on success, so the contract is throw on a
// non-zero `code` OR `subcode`; a clean parse with both zero (or absent) is
// a success. WRITE OP.

interface RawDeleteResponse {
  code?: number;
  subcode?: number;
  message?: string;
}

/**
 * Delete a 说说 by `tid` via taotao.qzone.qq.com's emotion_cgi_delete_v6 CGI
 * (proxied through h5.qzone.qq.com), on the bot's own space. Resolves on
 * success; THROWS on a transport failure or a non-zero Qzone `code` (e.g. an
 * unknown/foreign tid, or an auth failure). Only the bot's own feeds can be
 * deleted — the server rejects a tid the `hostUin` doesn't own.
 */
export async function deleteQzoneMsg(
  cookieObject: Record<string, string>,
  hostUin: string,
  tid: string,
): Promise<void> {
  if (!cookieObject || typeof cookieObject !== 'object') {
    throw new Error('cookieObject is required');
  }
  if (!tid) {
    throw new Error('tid is required');
  }

  const bkn = getBknFromCookie(cookieObject);
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6?g_tk=${bkn}`;
  // The canonical delete request uses `format=fs` (NOT json) and the exact
  // param set below — confirmed across the silica-github/qq_zone_delete
  // working script and community docs.
  const body = new URLSearchParams({
    hostuin: hostUin,
    tid,
    t1_source: '1',
    code_version: '1',
    format: 'fs',
    qzreferrer: `https://user.qzone.qq.com/${hostUin}`,
  }).toString();

  const text = await RequestUtil.HttpGetText(url, 'POST', body, {
    Cookie: cookieToString(cookieObject),
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  const data = parseQzoneJson<RawDeleteResponse>(text);

  // Success signal: delete has no positive payload, so we throw on a
  // non-zero code OR sub-code. NOTE: that `code`/`subcode` is delete's
  // success field is EXTRAPOLATED from the sibling CGIs (publish/msglist)
  // — public delete impls only check HTTP 2xx — so this is pending a live
  // capture to confirm the exact failure envelope (same posture as the
  // other helpers in this file).
  if (typeof data.code === 'number' && data.code !== 0) {
    log.warn('deleteQzoneMsg: non-zero code (uin=%s tid=%s) code=%d msg=%s', hostUin, tid, data.code, data.message);
    throw new Error(`qzone delete failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  if (typeof data.subcode === 'number' && data.subcode !== 0) {
    log.warn('deleteQzoneMsg: non-zero subcode (uin=%s tid=%s) subcode=%d msg=%s', hostUin, tid, data.subcode, data.message);
    throw new Error(`qzone delete failed: subcode=${data.subcode} ${data.message ?? ''}`.trim());
  }
}

// ─────────────── 点赞/取消赞 (like/unlike) — internal_dolike_app ───────────────
// Likes or unlikes a 说说 (mood, appid 311) on `targetUin`'s space, keyed by
// the feed's unikey/curkey (`http://user.qzone.qq.com/<uin>/mood/<tid>`,
// identical, http not https) and `fid` (= tid). The like CGI
// (internal_dolike_app), opuin=liker, unikey/curkey shape, and appid=311 are
// CONFIRMED against community impls (QLiker.py, CSDN 点赞协议). Two things are
// NOT live-verified and follow this file's "extrapolated, pending a live
// capture" posture:
//   • the UNLIKE endpoint `internal_unlike_app` — it's the conventional
//     paired CGI but no public bot impl exercises unlike, so it's best-guess.
//   • the success SIGNAL — we throw on a non-zero code/subcode (extrapolated
//     from sibling CGIs); the dolike response may instead carry a succ/fail
//     token, so a clean parse is treated as success.
// `abstime` (the target feed's post time) is threaded through because every
// real dolike impl sends it; 0 is a tolerated fallback when unknown.
// WRITE OP — rate-limit (likes are an active action,风控'd like messages).
// Scope is 说说 only; other feed types use a different unikey shape.

interface RawLikeResponse {
  code?: number;
  subcode?: number;
  message?: string;
}

/**
 * Like or unlike a 说说 by `tid` on `targetUin`'s space, as the bot
 * (`opUin`). `abstime` is the target feed's post time (unix seconds) — pass
 * the real value (from get_qzone_feeds/msglist) for reliability; 0 is a
 * tolerated fallback. Resolves on success; THROWS on a transport failure or
 * a non-zero Qzone `code`/`subcode`. `like=false` hits the (unverified)
 * unlike CGI.
 */
export async function setQzoneLike(
  cookieObject: Record<string, string>,
  opUin: string,
  targetUin: string,
  tid: string,
  like: boolean,
  abstime = 0,
): Promise<void> {
  if (!cookieObject || typeof cookieObject !== 'object') {
    throw new Error('cookieObject is required');
  }
  if (!tid) {
    throw new Error('tid is required');
  }

  const bkn = getBknFromCookie(cookieObject);
  const cgi = like ? 'internal_dolike_app' : 'internal_unlike_app';
  const url = `https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/${cgi}?g_tk=${bkn}`;
  // unikey/curkey address the 说说 (mood) feed; fid is the tid.
  const unikey = `http://user.qzone.qq.com/${targetUin}/mood/${tid}`;
  const body = new URLSearchParams({
    qzreferrer: `https://user.qzone.qq.com/${opUin}`,
    opuin: opUin,
    unikey,
    curkey: unikey,
    appid: '311',
    typeid: '0',
    abstime: String(abstime),
    fid: tid,
    from: '1',
    active: '0',
    fupdate: '1',
    format: 'json',
  }).toString();

  const text = await RequestUtil.HttpGetText(url, 'POST', body, {
    Cookie: cookieToString(cookieObject),
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  const data = parseQzoneJson<RawLikeResponse>(text);

  const verb = like ? 'like' : 'unlike';
  if (typeof data.code === 'number' && data.code !== 0) {
    log.warn('setQzoneLike(%s): non-zero code (tid=%s) code=%d msg=%s', verb, tid, data.code, data.message);
    throw new Error(`qzone ${verb} failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  if (typeof data.subcode === 'number' && data.subcode !== 0) {
    log.warn('setQzoneLike(%s): non-zero subcode (tid=%s) subcode=%d msg=%s', verb, tid, data.subcode, data.message);
    throw new Error(`qzone ${verb} failed: subcode=${data.subcode} ${data.message ?? ''}`.trim());
  }
}

// ─────────────── 上传图片 (upload image) — cgi_upload_image ───────────────
// Uploads an image to Qzone's hosting and returns metadata for use in
// publish/comment. The image is POSTed as base64 to up.qzone.qq.com
// (bypassing the h5 proxy — the upload CGI is NOT behind
// h5.qzone.qq.com/proxy). Body is form-urlencoded with `base64=1` and the
// base64 payload in `picfile`. Response is a JSONP wrapper (parsed with the
// shared tolerant parser) carrying `albumid`, `lloc`, `height`, `width`,
// `type`, and `url`. The `richval` (for publish's richval param) is
// constructed as `,albumid,lloc,sloc,type,height,width,,height,width` — the
// double height/width mirrors the PHP impl. WRITE OP — rate-limit (though
// upload itself is not风控'd like publish, batching huge uploads is impolite).
// Confirmed against php-qzone/qzone.class.php:97-172.

interface RawUploadImageResponse {
  code?: number;
  subcode?: number;
  message?: string;
  data?: {
    albumid?: string;
    lloc?: string;
    url?: string;
    type?: number;
    height?: number;
    width?: number;
  };
}

/** Result of uploading an image to Qzone. */
export interface QzoneUploadImageResult {
  [key: string]: JsonValue;
  /** Richval string for publish's `richval` param (multi-image: join with `\t`). */
  richval: string;
  /** Direct URL to the uploaded image. */
  url: string;
  albumid: string;
  lloc: string;
  type: number;
  width: number;
  height: number;
}

/**
 * Upload an image from a source (file:// / http:// / base64://) to Qzone
 * hosting. Loads the image via {@link loadBinarySource}, converts to base64,
 * and uploads via {@link uploadQzoneImage}.
 *
 * `source` supports:
 * - `file://` local file path
 * - `http://` or `https://` remote URL
 * - `base64://` base64-encoded data (with or without data-URI prefix)
 *
 * Errors PROPAGATE from both the load step and the upload step.
 */
export async function uploadQzoneImageFromSource(
  cookieObject: Record<string, string>,
  hostUin: string,
  source: string,
): Promise<QzoneUploadImageResult> {
  if (/^base64:\/\//i.test(source)) {
    return uploadQzoneImage(cookieObject, hostUin, source);
  }
  // Import loadBinarySource at function level to avoid circular deps
  const { loadBinarySource } = await import('../highway/utils');
  const loaded = await loadBinarySource(source, 'qzone-image');
  const base64 = Buffer.from(loaded.bytes).toString('base64');
  return uploadQzoneImage(cookieObject, hostUin, base64);
}

/**
 * Upload an image (as base64) to Qzone hosting via up.qzone.qq.com's
 * cgi_upload_image CGI. Returns metadata including the `richval` string
 * (for use in {@link publishQzoneMsg}'s richval param) and the direct URL.
 * Multi-image publish: call this once per image and join the richval strings
 * with `\t`.
 *
 * `imageBase64` is the raw base64-encoded image bytes; a data-URI prefix is
 * tolerated and stripped. Errors PROPAGATE: invalid base64, a transport
 * failure, a non-zero Qzone `code`/`subcode`, or a success body missing
 * required fields all throw.
 */
export async function uploadQzoneImage(
  cookieObject: Record<string, string>,
  hostUin: string,
  imageBase64: string,
): Promise<QzoneUploadImageResult> {
  if (!cookieObject || typeof cookieObject !== 'object') {
    throw new Error('cookieObject is required');
  }
  if (!imageBase64) {
    throw new Error('imageBase64 is required');
  }
  const base64 = normalizeQzoneImageBase64(imageBase64);

  const skey = cookieObject['skey'] || '';
  const pskey = cookieObject['p_skey'] || '';
  const bkn = getBknFromCookie(cookieObject);

  const url = `https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${bkn}`;
  const body = new URLSearchParams({
    filename: 'filename',
    uin: hostUin,
    skey,
    zzpaneluin: hostUin,
    p_uin: hostUin,
    p_skey: pskey,
    uploadtype: '1',
    albumtype: '7',
    exttype: '0',
    refer: 'shuoshuo',
    output_type: 'jsonhtml',
    charset: 'utf-8',
    output_charset: 'utf-8',
    upload_hd: '1',
    hd_width: '2048',
    hd_height: '10000',
    hd_quality: '96',
    backUrls: `http://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image,http://119.147.64.75/cgi-bin/upload/cgi_upload_image&url=https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${bkn}`,
    base64: '1',
    jsonhtml_callback: 'callback',
    picfile: base64,
    qzreferrer: `https://user.qzone.qq.com/${hostUin}/main`,
  }).toString();

  const text = await RequestUtil.HttpGetText(url, 'POST', body, {
    Cookie: cookieToString(cookieObject),
    'Content-Type': 'application/x-www-form-urlencoded',
  });

  // Response is `<script>frameElement.callback(...JSON...);</script>` — slice
  // from the first `{` to the last `}` (same as parseQzoneJson, but the
  // wrapper shape differs slightly).
  let jsonText = text.trim();
  const callbackStart = jsonText.indexOf('callback');
  if (callbackStart !== -1) {
    jsonText = jsonText.slice(callbackStart);
  }
  const data = parseQzoneJson<RawUploadImageResponse>(jsonText);

  if (typeof data.code === 'number' && data.code !== 0) {
    log.warn('uploadQzoneImage: non-zero code (uin=%s) code=%d msg=%s', hostUin, data.code, data.message);
    throw new Error(`qzone upload image failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  if (typeof data.subcode === 'number' && data.subcode !== 0) {
    log.warn('uploadQzoneImage: non-zero subcode (uin=%s) subcode=%d msg=%s', hostUin, data.subcode, data.message);
    throw new Error(`qzone upload image failed: subcode=${data.subcode} ${data.message ?? ''}`.trim());
  }
  if (!data.data || !data.data.albumid || !data.data.lloc || !data.data.url) {
    log.warn('uploadQzoneImage: missing required fields in response (uin=%s)', hostUin);
    throw new Error('上传图片失败:响应缺少必要字段');
  }

  const { albumid, lloc, url: imageUrl, type, height, width } = data.data;
  const sloc = lloc; // lloc and sloc are identical in the wire format
  const richval = `,${albumid},${lloc},${sloc},${type ?? 0},${height ?? 0},${width ?? 0},,${height ?? 0},${width ?? 0}`;

  return {
    richval,
    url: imageUrl,
    albumid,
    lloc,
    type: type ?? 0,
    width: width ?? 0,
    height: height ?? 0,
  };
}

// ─────────────── 评论说说 (comment) — emotion_cgi_re_feeds ───────────────
// Posts a comment on a 说说 owned by `hostUin`, as the bot (`selfUin`). Same
// form-POST mechanics + param family (paramstr/richtype/richval) as
// publishQzoneMsg. The `topicId` keys the target feed as `<hostUin>_<tid>`;
// the trailing `__1` suffix is CONFIRMED on 2/3 community impls but a third
// omits it, so the suffix specifically is the unverified piece (the base
// shape is confirmed). `uin`=commenter(self), `hostUin`=feed owner — verified
// not-swapped across 3 impls. Success is `code 0` (throw on non-zero code/
// subcode); the new comment id is returned best-effort (the response field
// name varies — commentid/commentId — so a missing id is NOT a failure when
// code is 0). WRITE OP — rate-limit. The topicId `__1` suffix + comment-id
// field are extrapolated, pending a live capture.

interface RawCommentResponse {
  code?: number;
  subcode?: number;
  message?: string;
  commentid?: string | number;
  commentId?: string | number;
}

/** Result of commenting on a 说说. */
export interface QzoneCommentResult {
  [key: string]: JsonValue;
  /** New comment id when the response carries one ('' if absent). */
  comment_id: string;
}

/**
 * Comment on a 说说 (`tid`, owned by `hostUin`) as the bot (`selfUin`) via
 * taotao.qzone.qq.com's emotion_cgi_re_feeds CGI (proxied through
 * h5.qzone.qq.com, matching php-qzone's working request).
 *
 * `richType` / `richval`: for image comments, set `richType=1` and pass the
 * direct image URL from {@link uploadQzoneImage}'s `url` field (NOT the
 * richval string — comment uses the direct URL, unlike publish which uses
 * richval). Multi-image comments use direct URLs joined with `\t`. Omit both
 * for text-only comments.
 *
 * Resolves with the new comment id (best-effort) on success; THROWS on a
 * transport failure or a non-zero Qzone `code`/`subcode` (e.g. comments
 * disabled, no permission, or auth failure).
 */
export async function commentQzoneMsg(
  cookieObject: Record<string, string>,
  selfUin: string,
  hostUin: string,
  tid: string,
  content: string,
  richType?: number,
  richval?: string,
): Promise<QzoneCommentResult> {
  if (!cookieObject || typeof cookieObject !== 'object') {
    throw new Error('cookieObject is required');
  }
  if (!tid) {
    throw new Error('tid is required');
  }
  if (!content) {
    throw new Error('content is required');
  }
  assertRichParams(richType, richval);

  const bkn = getBknFromCookie(cookieObject);
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${bkn}`;
  const body = new URLSearchParams({
    // qzreferrer carries the commenter's (self) space, matching the impls.
    qzreferrer: `https://user.qzone.qq.com/${selfUin}`,
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    hostUin,
    format: 'json',
    ref: 'feeds',
    topicId: `${hostUin}_${tid}__1`,
    feedsType: '100',
    private: '0',
    paramstr: '1',
    richtype: richType !== undefined ? String(richType) : '',
    richval: richval ?? '',
    isSignIn: '',
    uin: selfUin,
    content,
    plat: 'qzone',
    source: 'ic',
    platformid: '52',
  }).toString();

  const text = await RequestUtil.HttpGetText(url, 'POST', body, {
    Cookie: cookieToString(cookieObject),
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  const data = parseQzoneJson<RawCommentResponse>(text);

  if (typeof data.code === 'number' && data.code !== 0) {
    log.warn('commentQzoneMsg: non-zero code (host=%s tid=%s) code=%d msg=%s', hostUin, tid, data.code, data.message);
    throw new Error(`qzone comment failed: code=${data.code} ${data.message ?? ''}`.trim());
  }
  if (typeof data.subcode === 'number' && data.subcode !== 0) {
    log.warn('commentQzoneMsg: non-zero subcode (host=%s tid=%s) subcode=%d msg=%s', hostUin, tid, data.subcode, data.message);
    throw new Error(`qzone comment failed: subcode=${data.subcode} ${data.message ?? ''}`.trim());
  }

  const commentId = data.commentid ?? data.commentId;
  return { comment_id: commentId !== undefined ? String(commentId) : '' };
}

// ─────── 改说说权限 (update right) — emotion_cgi_msgdetail_v6 + emotion_cgi_update ───────
// Changes the view permission (ugc_right) of an EXISTING 说说. The update CGI
// is not a partial patch — it re-submits the whole feed (content, richval,
// pic_bo, …), so the flow is two-step: GET the feed detail from
// emotion_cgi_msgdetail_v6 (NOTE: proxied domain is taotao.qq.com, not
// taotao.qzone.qq.com — that's what the working impl hits), rebuild the full
// publish-shaped payload from it, override ugc_right/allow_uins, and POST to
// emotion_cgi_update. Both the detail param set and the payload rebuild are
// CONFIRMED against php-qzone/qzone.class.php updateRight (live-verified
// there); success signal is `subcode == 0`, same envelope as the siblings.
// WRITE OP — rate-limit like publish.

interface RawMsgDetailPic {
  pic_id?: string;
  pictype?: number | string;
  type?: number | string;
  height?: number | string;
  b_height?: number | string;
  width?: number | string;
  b_width?: number | string;
  smallurl?: string;
  url1?: string;
  url2?: string;
  url3?: string;
}

interface RawMsgDetailResponse {
  code?: number;
  subcode?: number;
  message?: string;
  msg?: string;
  tid?: string;
  uin?: number | string;
  content?: string;
  conlist?: Array<{ con?: string }> | null;
  pic?: RawMsgDetailPic[] | null;
  richtype?: number | string;
  richval?: string;
  pic_template?: string;
  special_url?: string;
  t1_subtype?: number | string;
  subrichtype?: number | string;
  feedversion?: number | string;
  ver?: number | string;
  ugc_right?: number | string;
  to_sign?: number | string;
  ugcright_id?: string;
  code_version?: number | string;
}

interface RawUpdateResponse {
  code?: number;
  subcode?: number;
  message?: string;
  msg?: string;
  ugc_right?: number | string;
}

/** Result of changing a 说说's view permission. */
export interface QzoneUpdateRightResult {
  [key: string]: JsonValue;
  /** The feed's ugc_right after the update (echoed by the server when present). */
  ugc_right: number;
}

/**
 * Rebuild the full emotion_cgi_update payload from a msgdetail_v6 response.
 * Field-for-field port of php-qzone's buildUpdatePayloadFromDetail: richval
 * strings are reconstructed from each `pic[].pic_id` (`,albumid,lloc,sloc,
 * type,height,width,,0,0`, tab-joined), `pic_bo` from the `bo=` query param
 * of any picture URL variant (group tab-doubled), and the content from
 * `conlist` when present. Exported for tests; THROWS on a detail body it
 * cannot rebuild from (missing tid, or an image post whose pic info is
 * unusable) rather than submitting a lossy update.
 */
export function buildQzoneUpdatePayload(detail: RawMsgDetailResponse, selfUin: string): URLSearchParams {
  if (!detail.tid) {
    throw new Error('qzone msg detail is missing tid');
  }

  const pics = detail.pic ?? [];
  const richtype = detail.richtype !== undefined ? Number(detail.richtype) : (pics.length === 0 ? '' : 1);
  const richvals: string[] = [];
  const picBoItems: string[] = [];

  for (const pic of pics) {
    const picId = String(pic.pic_id ?? '');
    if (!picId) continue;

    const parts = picId.split(',');
    const albumId = parts[1] ?? '';
    const lloc = parts[2] ?? '';
    if (!albumId || !lloc) {
      throw new Error('qzone msg detail has unsupported pic info');
    }

    const sloc = lloc;
    const picType = String(pic.pictype ?? pic.type ?? 22);
    const height = String(pic.height ?? pic.b_height ?? 0);
    const width = String(pic.width ?? pic.b_width ?? 0);
    richvals.push(`,${albumId},${lloc},${sloc},${picType},${height},${width},,0,0`);

    for (const urlKey of ['smallurl', 'url1', 'url2', 'url3'] as const) {
      const picUrl = pic[urlKey];
      if (!picUrl) continue;
      const match = /[?&]bo=([^&#]+)/.exec(picUrl);
      if (match) {
        picBoItems.push(decodeURIComponent(match[1]!));
        break;
      }
    }
  }

  if (richtype === 1 && richvals.length === 0) {
    throw new Error('qzone image post detail is missing pic info');
  }

  let content = detail.content ?? '';
  const conParts = (detail.conlist ?? [])
    .map((c) => c.con)
    .filter((c): c is string => c !== undefined);
  if (conParts.length > 0) {
    content = conParts.join('').trim();
  }

  const subrichtype = detail.t1_subtype ?? detail.subrichtype ?? (richvals.length === 0 ? '' : 1);
  const boGroup = picBoItems.join(',');
  const picBo = boGroup ? `${boGroup}\t${boGroup}` : '';

  const hostuin = String(detail.uin ?? selfUin);
  return new URLSearchParams({
    syn_tweet_verson: '1',
    tid: String(detail.tid),
    paramstr: '1',
    pic_template: detail.pic_template ?? '',
    richtype: String(richtype),
    richval: richvals.length > 0 ? richvals.join('\t') : (detail.richval ?? ''),
    special_url: detail.special_url ?? '',
    subrichtype: String(subrichtype),
    pic_bo: picBo,
    con: content,
    feedversion: String(detail.feedversion ?? 1),
    ver: String(detail.ver ?? 1),
    ugc_right: String(Number(detail.ugc_right ?? 1)),
    to_sign: String(Number(detail.to_sign ?? 0)),
    ugcright_id: String(detail.ugcright_id ?? detail.tid),
    hostuin,
    code_version: String(detail.code_version ?? 1),
    format: 'fs',
    qzreferrer: `https://user.qzone.qq.com/${hostuin}`,
  });
}

/** Fetch one 说说's full detail (the update payload's source of truth). */
async function getQzoneMsgDetail(
  cookieObject: Record<string, string>,
  selfUin: string,
  tid: string,
): Promise<RawMsgDetailResponse> {
  const bkn = getBknFromCookie(cookieObject);
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?${new URLSearchParams(
    {
      tid,
      uin: selfUin,
      t1_source: '1',
      not_trunc_con: '1',
      need_right: '1',
      not_adapt_outpic: '1',
      g_tk: bkn,
    },
  ).toString()}`;

  const text = await RequestUtil.HttpGetText(url, 'GET', '', {
    Cookie: cookieToString(cookieObject),
  });
  log.trace('getQzoneMsgDetail raw body (tid=%s): %s', tid, text);
  const data = parseQzoneJson<RawMsgDetailResponse>(text);

  const code = data.subcode ?? data.code ?? -1;
  if (code !== 0) {
    log.warn('getQzoneMsgDetail: non-zero code (tid=%s) code=%d msg=%s', tid, code, data.message ?? data.msg);
    throw new Error(`qzone msg detail failed: code=${code} ${data.message ?? data.msg ?? ''}`.trim());
  }
  return data;
}

/**
 * Change the view permission of an existing 说说 (`tid`, on the bot's own
 * space) via the msgdetail_v6 → emotion_cgi_update two-step. `ugcRight` is
 * one of 1(所有人)/4(好友)/16(部分可见)/64(仅自己)/128(部分不可见);
 * `targetUins` (|-separated QQ numbers) is required for 16/128 and ignored
 * otherwise. Errors PROPAGATE from both steps: a transport failure, a
 * non-zero Qzone code on the detail fetch (unknown/foreign tid, auth), an
 * unrebuildable detail, or a non-zero `subcode` on the update all throw.
 */
export async function updateQzoneMsgRight(
  cookieObject: Record<string, string>,
  selfUin: string,
  tid: string,
  ugcRight: number,
  targetUins?: string,
): Promise<QzoneUpdateRightResult> {
  if (!cookieObject || typeof cookieObject !== 'object') {
    throw new Error('cookieObject is required');
  }
  if (!tid) {
    throw new Error('tid is required');
  }

  const right = normalizeQzoneUgcRight(ugcRight);
  const effectiveTargetUins = right === 16 || right === 128 ? normalizeTargetUins(targetUins) : '';
  if ((right === 16 || right === 128) && !effectiveTargetUins) {
    throw new Error('target_uins is required when ugc_right is 16 or 128');
  }

  const detail = await getQzoneMsgDetail(cookieObject, selfUin, tid);
  const bodyParams = buildQzoneUpdatePayload(detail, selfUin);
  bodyParams.set('ugc_right', String(right));
  if (effectiveTargetUins) bodyParams.set('allow_uins', effectiveTargetUins);

  const bkn = getBknFromCookie(cookieObject);
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_update?g_tk=${bkn}`;
  const text = await RequestUtil.HttpGetText(url, 'POST', bodyParams.toString(), {
    Cookie: cookieToString(cookieObject),
    'Content-Type': 'application/x-www-form-urlencoded',
  });
  // format=fs wraps the JSON in a callback (`frameElement.callback({...});`
  // or `_Callback({...});`) — parseQzoneJson's first-{-to-last-} slice
  // handles every observed variant.
  const data = parseQzoneJson<RawUpdateResponse>(text);

  if (typeof data.subcode === 'number' && data.subcode !== 0) {
    log.warn('updateQzoneMsgRight: non-zero subcode (tid=%s) subcode=%d msg=%s', tid, data.subcode, data.message ?? data.msg);
    throw new Error(`qzone update right failed: subcode=${data.subcode} ${data.message ?? data.msg ?? ''}`.trim());
  }
  if (typeof data.code === 'number' && data.code !== 0) {
    log.warn('updateQzoneMsgRight: non-zero code (tid=%s) code=%d msg=%s', tid, data.code, data.message ?? data.msg);
    throw new Error(`qzone update right failed: code=${data.code} ${data.message ?? data.msg ?? ''}`.trim());
  }

  return { ugc_right: Number(data.ugc_right ?? right) };
}
