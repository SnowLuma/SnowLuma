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

/** Result of publishing a 说说. */
export interface QzonePublishResult {
  [key: string]: JsonValue;
  /** The new feed's id — the handle for a later delete/comment/like. */
  tid: string;
  /** Unix seconds the 说说 was published. */
  time: number;
}

/**
 * Publish a text-only 说说 via taotao.qzone.qq.com's emotion_cgi_publish_v6
 * CGI (proxied through h5.qzone.qq.com). POSTs a form-urlencoded body with
 * `g_tk` in the query, on the bot's own space (`hostUin`).
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
): Promise<QzonePublishResult> {
  if (!cookieObject || typeof cookieObject !== 'object') {
    throw new Error('cookieObject is required');
  }
  if (!content) {
    throw new Error('content is required');
  }

  const bkn = getBknFromCookie(cookieObject);
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${bkn}`;
  const body = new URLSearchParams({
    syn_tweet_verson: '1',
    paramstr: '1',
    pic_template: '',
    richtype: '',
    richval: '',
    special_url: '',
    subrichtype: '',
    con: content,
    feedversion: '1',
    ver: '1',
    ugc_right: '1',
    to_sign: '0',
    who: '1',
    hostuin: hostUin,
    code_version: '1',
    format: 'json',
    qzreferrer: `https://user.qzone.qq.com/${hostUin}`,
  }).toString();

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
 * taotao.qzone.qq.com's emotion_cgi_re_feeds CGI (proxied through h5.qzone).
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

  const bkn = getBknFromCookie(cookieObject);
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${bkn}`;
  const body = new URLSearchParams({
    // qzreferrer carries the commenter's (self) space, matching the impls.
    qzreferrer: `https://user.qzone.qq.com/${selfUin}`,
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    hostUin,
    format: 'fs',
    ref: 'feeds',
    topicId: `${hostUin}_${tid}__1`,
    feedsType: '100',
    private: '0',
    paramstr: '1',
    richtype: '',
    richval: '',
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
