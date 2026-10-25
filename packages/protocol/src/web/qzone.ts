import type { JsonValue } from '@snowluma/common/json';
import { createLogger } from '@snowluma/common/logger';
import { RequestUtil, cookieToString, getBknFromCookie } from './request-util';
import { parseQzoneFeedContent, type QzoneFeedContent } from './qzone-feed-content';
import {
    decodeQzoneFeedCursor,
    encodeQzoneFeedCursor,
    initialQzoneFeedState,
    nextQzoneFeedState,
    qzoneFeedPosition,
} from './qzone-feed-cursor';

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

export interface QzoneProfile {
    [key: string]: JsonValue;
    name: string;
    description: string;
}

export interface QzoneProfileUpdate {
    name?: string;
    description?: string;
}

export interface QzoneCommentReply {
    [key: string]: JsonValue;
    uin: number;
    name: string;
    /** Unix seconds. */
    time: number;
    content: string;
    /** Scoped to the containing post (or parent comment for replies). */
    comment_id: string;
}

export interface QzoneComment extends QzoneCommentReply {
    /** Inline replies supplied by Qzone; may not include every reply. */
    replies: QzoneCommentReply[];
}

export interface QzoneMsgDetailResult {
    [key: string]: JsonValue;
    tid: string;
    content: string;
    /** Server-reported total, not the length of this comment page. */
    comment_num: number;
    comments: QzoneComment[];
}

/**
 * Parse a Qzone CGI body that may be raw JSON or a JSONP callback wrapper
 * (`_Callback({...});` / `callback({...})`). Uses a layered fallback approach:
 *
 * 1. Try direct JSON.parse on the first `{` to last `}` slice.
 * 2. Try `back({...})` pattern (the original approach).
 * 3. Extract `back(...)` content, trim, then locate `{}` inside.
 *
 * This is robust to the various callback name variants Qzone uses.
 * Throws if no object body is present (e.g. an HTML error page).
 */
export function parseQzoneJson<T>(text: string): T {
    const s = text.trim();

    // 1st: try direct JSON parse via {}
    try {
        const start = s.indexOf('{');
        const end = s.lastIndexOf('}');

        if (start !== -1 && end !== -1 && end > start) {
            return JSON.parse(s.slice(start, end + 1)) as T;
        }
    } catch {
        /* fallback */
    }

    // 2nd: try back({...}) as a whole
    try {
        const start = s.indexOf('back({');
        const end = s.lastIndexOf('})');

        if (start !== -1 && end !== -1 && end > start) {
            return JSON.parse(s.slice(start + 5, end + 1)) as T;
        }
    } catch {
        /* fallback */
    }

    // 3rd: find last back(...); occurrence, then extract {} from within
    const backStart = s.lastIndexOf('back(');

    if (backStart === -1) {
        throw new Error('invalid response from qzone api');
    }

    // find the nearest ');' after back( to delimit the callback invocation
    const callEnd = s.indexOf(');', backStart);

    if (callEnd === -1) {
        throw new Error('invalid response from qzone api');
    }

    const inner = s.slice(backStart + 5, callEnd).trim();
    const braceStart = inner.indexOf('{');
    const braceEnd = inner.lastIndexOf('}');

    if (braceStart === -1 || braceEnd === -1 || braceEnd < braceStart) {
        throw new Error('invalid response from qzone api');
    }

    return JSON.parse(inner.slice(braceStart, braceEnd + 1)) as T;
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
    const isWs = (c: string): boolean =>
        c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

    const skipWs = (): void => {
        while (i < n && isWs(src[i]!)) {
            i++;
        }
    };

    function parseString(quote: string): string {
        i++; // opening quote
        let out = '';

        while (i < n) {
            const c = src[i]!;

            if (c === '\\') {
                const e = src[i + 1];

                if (e === 'x') {
                    out += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
                    i += 4;
                    continue;
                }

                if (e === 'u') {
                    out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
                    i += 6;
                    continue;
                }

                const simple: Record<string, string> = {
                    n: '\n',
                    t: '\t',
                    r: '\r',
                    b: '\b',
                    f: '\f',
                    v: '\v',
                    '0': '\0',
                };
                out += e !== undefined ? (simple[e] ?? e) : ''; // \/ → /, \' → ', unknown → the char
                i += 2;
                continue;
            }

            if (c === quote) {
                i++;
                return out;
            }

            out += c;
            i++;
        }

        throw new Error('unterminated string in qzone feeds payload');
    }

    function parseKey(): string {
        skipWs();
        const c = src[i];

        if (c === '"' || c === "'") {
            return parseString(c);
        }

        let s = '';

        while (i < n && /[A-Za-z0-9_$]/.test(src[i]!)) {
            s += src[i];
            i++;
        }

        if (!s) {
            throw new Error('expected object key in qzone feeds payload');
        }

        return s;
    }

    function parseObject(): Record<string, unknown> {
        i++; // {
        const obj: Record<string, unknown> = {};
        skipWs();

        if (src[i] === '}') {
            i++;
            return obj;
        }

        for (;;) {
            const key = parseKey();
            skipWs();

            if (src[i] !== ':') {
                throw new Error('expected ":" in qzone feeds payload');
            }

            i++;
            const value = parseValue();

            if (key !== '__proto__') {
                obj[key] = value;
            }

            skipWs();
            const ch = src[i];

            if (ch === ',') {
                i++;
                skipWs();

                if (src[i] === '}') {
                    i++;
                    return obj;
                }

                continue;
            }

            if (ch === '}') {
                i++;
                return obj;
            }

            throw new Error('expected "," or "}" in qzone feeds payload');
        }
    }

    function parseArray(): unknown[] {
        i++; // [
        const arr: unknown[] = [];
        skipWs();

        if (src[i] === ']') {
            i++;
            return arr;
        }

        for (;;) {
            arr.push(parseValue());
            skipWs();
            const ch = src[i];

            if (ch === ',') {
                i++;
                skipWs();

                if (src[i] === ']') {
                    i++;
                    return arr;
                }

                continue;
            }

            if (ch === ']') {
                i++;
                return arr;
            }

            throw new Error('expected "," or "]" in qzone feeds payload');
        }
    }

    function parseValue(): unknown {
        skipWs();
        const c = src[i];

        if (c === undefined) {
            throw new Error('unexpected end of qzone feeds payload');
        }

        if (c === '{') {
            return parseObject();
        }

        if (c === '[') {
            return parseArray();
        }

        if (c === '"' || c === "'") {
            return parseString(c);
        }

        let token = '';

        while (i < n && !/[,}\]:\s]/.test(src[i]!)) {
            token += src[i];
            i++;
        }

        if (token === 'true') {
            return true;
        }

        if (token === 'false') {
            return false;
        }

        if (token === 'null') {
            return null;
        }

        if (token === 'undefined') {
            return undefined;
        }

        if (token !== '') {
            const num = Number(token);

            if (!Number.isNaN(num)) {
                return num;
            }
        }

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

    if (start === -1) {
        throw new Error('invalid feeds response from qzone api');
    }

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

interface MsgListRoute {
    url: string;
    headers: Record<string, string>;
}

/** Legacy route (default): h5.qzone.qq.com → taotao.qzone.qq.com. */
function legacyMsgListRoute(
    cookieObject: Record<string, string>,
    targetUin: string,
    pos: number,
    num: number,
    bkn: string,
): MsgListRoute {
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
    return { url, headers: { Cookie: cookieToString(cookieObject) } };
}

/**
 * Fallback route: user.qzone.qq.com → taotao.qq.com (NOT taotao.qzone.qq.com).
 * Live captures show this pair is not subject to the `-10000` rate-limit the
 * legacy route can hit.
 */
function userMsgListRoute(
    cookieObject: Record<string, string>,
    targetUin: string,
    pos: number,
    num: number,
    bkn: string,
): MsgListRoute {
    const url = `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?${new URLSearchParams(
        {
            uin: targetUin,
            ftype: '0',
            sort: '0',
            pos: String(pos),
            num: String(num),
            g_tk: bkn,
            code_version: '1',
            format: 'json',
        },
    ).toString()}`;
    return {
        url,
        headers: {
            Cookie: cookieToString(cookieObject),
            Referer: `https://user.qzone.qq.com/${targetUin}`,
        },
    };
}

async function requestMsgList(
    route: MsgListRoute,
    targetUin: string,
): Promise<{ data: RawMsgListResponse; text: string }> {
    const text = await RequestUtil.HttpGetText(route.url, 'GET', '', route.headers);
    log.trace('getQzoneMsgList raw body (uin=%s): %s', targetUin, text);
    return { data: parseQzoneJson<RawMsgListResponse>(text), text };
}

/**
 * Fetch a 说说 (Qzone emotion/feed) list via the taotao.qzone.qq.com web
 * API, proxied through h5.qzone.qq.com — the same cookie/g_tk plumbing the
 * group-album helper uses. Defaults to the bot's own space; `targetUin`
 * can name any space the bot may view. On a `-10000` rate-limit from that
 * route, retries once via the user.qzone.qq.com route (see
 * {@link userMsgListRoute}).
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
    let { data, text } = await requestMsgList(
        legacyMsgListRoute(cookieObject, targetUin, pos, num, bkn),
        targetUin,
    );

    // -10000「使用人数过多」is route-specific to the legacy gateway; retry once
    // via the user.qzone.qq.com route, which live captures show is not limited.
    if (data.code === -10000) {
        log.warn(
            'getQzoneMsgList: legacy route rate-limited (uin=%s), retrying via user.qzone route',
            targetUin,
        );
        ({ data, text } = await requestMsgList(
            userMsgListRoute(cookieObject, targetUin, pos, num, bkn),
            targetUin,
        ));
    }

    if (typeof data.code === 'number' && data.code !== 0) {
        log.warn(
            'getQzoneMsgList: non-zero code (uin=%s) code=%d msg=%s',
            targetUin,
            data.code,
            data.message,
        );
        throw new Error(`qzone msglist failed: code=${data.code} ${data.message ?? ''}`.trim());
    }

    if (!Array.isArray(data.msglist)) {
        log.warn(
            'getQzoneMsgList: no msglist in response (uin=%s) — likely auth/cookie failure or unverified response shape; body head=%s',
            targetUin,
            text.slice(0, 300),
        );
        throw new Error(`无法获取空间说说列表（响应结构异常）: ${text.slice(0, 200)}`);
    }

    return mapMsgList(data);
}

// ─────────────── 好友动态 (friend feeds) — feeds3_html_more ───────────────
interface RawFeedItem {
    uin?: number | string;
    nickname?: string;
    abstime?: number | string;
    appid?: number | string;
    typeid?: number | string;
    key?: string;
    feedskey?: string;
    html?: string;
    likecnt?: number | string;
    commentcnt?: number | string;
}

interface RawFeedsResponse {
    code?: number;
    subcode?: number;
    message?: string;
    data?: {
        data?: RawFeedItem[] | null;
        main?: Record<string, unknown>;
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

export interface QzoneStructuredFeed extends QzoneFeed, QzoneFeedContent {}

export interface QzoneFeedsPage extends QzoneFeedsResult {
    feeds: QzoneStructuredFeed[];
    /** Opaque, account-bound continuation. Null at the end of the list. */
    next_cursor: string | null;
}

function feedHasMore(data: RawFeedsResponse): boolean {
    const value = data.data?.main === undefined ? data.data?.hasmore : data.data.main.hasMoreFeeds;

    if (value === true || value === 1 || value === '1') {
        return true;
    }

    if (value === false || value === 0 || value === '0') {
        return false;
    }

    throw new Error('空间好友动态缺少有效的分页结束标志');
}

/** Pure mapping; request continuation is attached by getQzoneFeeds. */
export function mapFeeds(data: RawFeedsResponse): QzoneFeedsPage {
    if (!Array.isArray(data.data?.data)) {
        throw new Error('无法获取空间好友动态（响应结构异常）');
    }

    // The web payload pads lists with null/undefined; these are not feed entries.
    const list = data.data.data.filter((item) => item != null);
    return {
        feeds: list.map((item) => {
            if (typeof item !== 'object' || Array.isArray(item)) {
                throw new Error('空间好友动态条目结构异常');
            }

            const feed: QzoneFeed = {
                uin: Number(item.uin ?? 0),
                nickname: item.nickname ?? '',
                time: Number(item.abstime ?? 0),
                appid: Number(item.appid ?? 0),
                key: String(item.key ?? item.feedskey ?? ''),
                html: item.html ?? '',
            };

            if (
                ![feed.uin, feed.time, feed.appid].every(
                    (n) => Number.isSafeInteger(n) && n >= 0,
                ) ||
                typeof feed.nickname !== 'string' ||
                typeof feed.html !== 'string'
            ) {
                throw new Error('空间好友动态条目字段异常');
            }

            return {
                ...feed,
                ...parseQzoneFeedContent(
                    feed.html,
                    feed.key,
                    feed.uin,
                    feed.appid,
                    item.likecnt,
                    item.commentcnt,
                ),
            };
        }),
        has_more: feedHasMore(data),
        next_cursor: null,
    };
}

/** Read one page. Legacy page numbers walk continuations from the beginning. */
export async function getQzoneFeeds(
    cookieObject: Record<string, string>,
    selfUin: string,
    pageNum = 1,
    count = 10,
    cursor?: string,
): Promise<QzoneFeedsPage> {
    if (!cookieObject || typeof cookieObject !== 'object') {
        throw new Error('cookieObject is required');
    }

    if (
        !Number.isSafeInteger(pageNum) ||
        pageNum < 1 ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 50
    ) {
        throw new Error('空间好友动态页码或数量无效');
    }

    const start =
        cursor === undefined
            ? { page: 1, state: initialQzoneFeedState() }
            : decodeQzoneFeedCursor(cursor, selfUin);

    if (cursor !== undefined && pageNum !== 1 && pageNum !== start.page) {
        throw new Error('page_num 与空间好友动态 cursor 不匹配');
    }

    const target = cursor === undefined ? pageNum : start.page;
    const bkn = getBknFromCookie(cookieObject);
    let state = start.state;
    const seen = new Set([qzoneFeedPosition(state)]);
    log.debug(
        'getQzoneFeeds start (uin=%s page=%d count=%d cursor=%s)',
        selfUin,
        target,
        count,
        cursor !== undefined,
    );

    for (let page = start.page; page <= target; page++) {
        const query = new URLSearchParams({
            uin: selfUin,
            scope: '0',
            view: '1',
            gid: '',
            flag: '1',
            filter: 'all',
            applist: 'all',
            refresh: '0',
            firstGetGroup: '0',
            mixnocache: '0',
            scene: '0',
            sidomain: 'qzonestyle.gtimg.cn',
            count: String(count),
            ...state,
            getAisort: state.aisortNextTime,
            g_tk: bkn,
            callback: '_preloadCallback',
            format: 'jsonp',
            useutf8: '1',
            outputhtmlfeed: '1',
            usertime: String(Date.now()),
            rd: String(Math.random()),
            windowId: String(Math.random()),
        });
        query.delete('aisortNextTime');
        const url = `https://h5.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?${query}`;

        try {
            const body = await RequestUtil.HttpGetText(url, 'GET', '', {
                Cookie: cookieToString(cookieObject),
            });
            const data = parseQzoneCallback<RawFeedsResponse>(body);

            if (data.code !== 0 || (data.subcode !== undefined && data.subcode !== 0)) {
                throw new Error(
                    `qzone feeds failed: code=${data.code} subcode=${data.subcode ?? 0} ${typeof data.message === 'string' ? data.message : ''}`.trim(),
                );
            }

            const main = data.data?.main;

            if (
                main !== undefined &&
                (main === null || typeof main !== 'object' || Array.isArray(main))
            ) {
                throw new Error('空间好友动态分页信息结构异常');
            }

            if (main?.error !== undefined && main.error !== '') {
                throw new Error('空间好友动态服务端报告拉取失败');
            }

            const result = mapFeeds(data);

            if (result.has_more) {
                if (!main) {
                    throw new Error('空间好友动态缺少下一页游标');
                }

                state = nextQzoneFeedState(main, state);
                const position = qzoneFeedPosition(state);

                if (seen.has(position)) {
                    throw new Error('空间好友动态分页游标未推进');
                }

                seen.add(position);
                result.next_cursor = encodeQzoneFeedCursor(selfUin, page + 1, state);
            }

            const unavailable = result.feeds.filter(
                (feed) => feed.appid === 311 && feed.content === null,
            ).length;

            if (unavailable) {
                log.warn(
                    'getQzoneFeeds content unavailable (uin=%s page=%d entries=%d)',
                    selfUin,
                    page,
                    unavailable,
                );
            }

            log.debug(
                'getQzoneFeeds page (uin=%s page=%d entries=%d more=%s)',
                selfUin,
                page,
                result.feeds.length,
                result.has_more,
            );

            if (page === target) {
                return result;
            }

            if (!result.has_more) {
                return { feeds: [], has_more: false, next_cursor: null };
            }
        } catch (error) {
            log.warn(
                'getQzoneFeeds failed (uin=%s page=%d): %s',
                selfUin,
                page,
                error instanceof Error ? error.message : String(error),
            );
            throw error;
        }
    }

    throw new Error('空间好友动态分页未完成');
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

    if (!raw) {
        return '';
    }

    const seen = new Set<string>();

    for (const part of raw.split('|')) {
        const uin = part.trim();

        if (!uin) {
            continue;
        }

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
    const effectiveTargetUins =
        right === 16 || right === 128 ? normalizeTargetUins(targetUins) : '';

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

    if (effectiveTargetUins) {
        bodyParams.set('allow_uins', effectiveTargetUins);
    }

    const body = bodyParams.toString();

    const text = await RequestUtil.HttpGetText(url, 'POST', body, {
        Cookie: cookieToString(cookieObject),
        'Content-Type': 'application/x-www-form-urlencoded',
    });
    const data = parseQzoneJson<RawPublishResponse>(text);

    if (typeof data.code === 'number' && data.code !== 0) {
        log.warn(
            'publishQzoneMsg: non-zero code (uin=%s) code=%d msg=%s',
            hostUin,
            data.code,
            data.message,
        );
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
        log.warn(
            'deleteQzoneMsg: non-zero code (uin=%s tid=%s) code=%d msg=%s',
            hostUin,
            tid,
            data.code,
            data.message,
        );
        throw new Error(`qzone delete failed: code=${data.code} ${data.message ?? ''}`.trim());
    }

    if (typeof data.subcode === 'number' && data.subcode !== 0) {
        log.warn(
            'deleteQzoneMsg: non-zero subcode (uin=%s tid=%s) subcode=%d msg=%s',
            hostUin,
            tid,
            data.subcode,
            data.message,
        );
        throw new Error(
            `qzone delete failed: subcode=${data.subcode} ${data.message ?? ''}`.trim(),
        );
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
        log.warn(
            'setQzoneLike(%s): non-zero code (tid=%s) code=%d msg=%s',
            verb,
            tid,
            data.code,
            data.message,
        );
        throw new Error(`qzone ${verb} failed: code=${data.code} ${data.message ?? ''}`.trim());
    }

    if (typeof data.subcode === 'number' && data.subcode !== 0) {
        log.warn(
            'setQzoneLike(%s): non-zero subcode (tid=%s) subcode=%d msg=%s',
            verb,
            tid,
            data.subcode,
            data.message,
        );
        throw new Error(
            `qzone ${verb} failed: subcode=${data.subcode} ${data.message ?? ''}`.trim(),
        );
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
        log.warn(
            'uploadQzoneImage: non-zero code (uin=%s) code=%d msg=%s',
            hostUin,
            data.code,
            data.message,
        );
        throw new Error(
            `qzone upload image failed: code=${data.code} ${data.message ?? ''}`.trim(),
        );
    }

    if (typeof data.subcode === 'number' && data.subcode !== 0) {
        log.warn(
            'uploadQzoneImage: non-zero subcode (uin=%s) subcode=%d msg=%s',
            hostUin,
            data.subcode,
            data.message,
        );
        throw new Error(
            `qzone upload image failed: subcode=${data.subcode} ${data.message ?? ''}`.trim(),
        );
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

export interface QzoneReplyTarget {
    /** The top-level comment, even when replying to one of its replies. */
    commentId: string;
    commentUin: string;
    /** Optional author to address within that thread. */
    replyTo?: { uin: string; name: string };
}

export interface QzoneReplyResult extends QzoneCommentResult {
    parent_comment_id: string;
    parent_comment_uin: number;
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
// ─────────────── 拉黑/解拉黑 (ban/unban) — cgi_black_action_new ───────────────
// Adds or removes a user from the bot's QQ-Zone blacklist. The CGI is
// w.qzone.qq.com/cgi-bin/right/cgi_black_action_new (proxied through
// h5.qzone.qq.com). POST form-urlencoded with `action=1` to ban,
// `action=2` to unban. Response is a callback-wrapped body
// (frameElement.callback style). Confirmed against
// php-qzone/qzone.class.php:setQzoneRight. WRITE OP.

interface RawBlackActionResponse {
    code?: number;
    subcode?: number;
    message?: string;
    msg?: string;
}

/**
 * Ban (blacklist) or unban a user in the bot's QQ-Zone space via
 * w.qzone.qq.com's cgi_black_action_new CGI (proxied through
 * h5.qzone.qq.com). `ban=true` adds the target to the blacklist
 * (action=1); `ban=false` removes them (action=2). Resolves on success;
 * THROWS on a transport failure or a non-zero Qzone `subcode`.
 * Confirmed against php-qzone/qzone.class.php:setQzoneRight.
 */
export async function setQzoneBlack(
    cookieObject: Record<string, string>,
    selfUin: string,
    targetUin: string,
    ban: boolean,
): Promise<void> {
    if (!cookieObject || typeof cookieObject !== 'object') {
        throw new Error('cookieObject is required');
    }

    if (!targetUin) {
        throw new Error('targetUin is required');
    }

    const bkn = getBknFromCookie(cookieObject);
    const url = `https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/right/cgi_black_action_new?g_tk=${bkn}`;
    const body = new URLSearchParams({
        uin: selfUin,
        act_uin: targetUin,
        action: ban ? '1' : '2',
        fupdate: '1',
        qzreferrer: `https://user.qzone.qq.com/${selfUin}/main`,
    }).toString();

    const text = await RequestUtil.HttpGetText(url, 'POST', body, {
        Cookie: cookieToString(cookieObject),
        'Content-Type': 'application/x-www-form-urlencoded',
    });
    // Response is callback-wrapped (frameElement.callback style) and may contain
    // a small JS-object-literal fragment like `{name:"Ack"}`. Patch the known
    // unquoted key, then parse via the tolerant JSON/JSONP extractor.
    let data: RawBlackActionResponse;

    try {
        data = parseQzoneJson<RawBlackActionResponse>(text.replace(/\{\s*name\s*:/, '{"name":'));
    } catch {
        const snippet = text.trim().slice(0, 300);
        throw new Error(
            `qzone ${ban ? 'ban' : 'unban'} failed: ${snippet}${text.length > 300 ? '…' : ''}`,
        );
    }

    const verb = ban ? 'ban' : 'unban';

    if (typeof data.subcode === 'number' && data.subcode !== 0) {
        const msg = data.message ?? data.msg ?? '';
        log.warn(
            'setQzoneBlack(%s): non-zero subcode (target=%s) subcode=%d msg=%s',
            verb,
            targetUin,
            data.subcode,
            msg,
        );
        throw new Error(`qzone ${verb} failed: subcode=${data.subcode} ${msg}`.trim());
    }

    if (typeof data.code === 'number' && data.code !== 0) {
        const msg = data.message ?? data.msg ?? '';
        log.warn(
            'setQzoneBlack(%s): non-zero code (target=%s) code=%d msg=%s',
            verb,
            targetUin,
            data.code,
            msg,
        );
        throw new Error(`qzone ${verb} failed: code=${data.code} ${msg}`.trim());
    }
}

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
        log.warn(
            'commentQzoneMsg: non-zero code (host=%s tid=%s) code=%d msg=%s',
            hostUin,
            tid,
            data.code,
            data.message,
        );
        throw new Error(`qzone comment failed: code=${data.code} ${data.message ?? ''}`.trim());
    }

    if (typeof data.subcode === 'number' && data.subcode !== 0) {
        log.warn(
            'commentQzoneMsg: non-zero subcode (host=%s tid=%s) subcode=%d msg=%s',
            hostUin,
            tid,
            data.subcode,
            data.message,
        );
        throw new Error(
            `qzone comment failed: subcode=${data.subcode} ${data.message ?? ''}`.trim(),
        );
    }

    const commentId = data.commentid ?? data.commentId;
    return { comment_id: commentId !== undefined ? String(commentId) : '' };
}

/**
 * Reply within a Qzone comment thread. The web comment module uses a separate
 * reply endpoint: commentId/commentUin identify the parent, not a nested reply.
 * The addressed author is an automatic mention in content; there is no replyId
 * request field. Images are not part of this request's supported contract.
 * Request/result contract: qzonestyle.gtimg.cn/qzone/app/controls/commentModule/
 * viewModel/viewModel_3.0_common.js (ReplyViewModel.post).
 */
export async function replyQzoneComment(
    cookieObject: Record<string, string>,
    selfUin: string,
    hostUin: string,
    tid: string,
    content: string,
    target: QzoneReplyTarget,
): Promise<QzoneReplyResult> {
    if (!cookieObject || typeof cookieObject !== 'object') {
        throw new Error('cookieObject is required');
    }

    for (const [field, value] of Object.entries({
        selfUin,
        hostUin,
        commentUin: target.commentUin,
    })) {
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
            throw new Error(`${field} must be a positive safe integer`);
        }
    }

    if (!tid.trim() || !content.trim() || !target.commentId.trim()) {
        throw new Error('tid, content and commentId must not be blank');
    }

    let replyContent = content;

    if (target.replyTo !== undefined) {
        const { uin, name } = target.replyTo;

        if (!/^[1-9]\d*$/.test(uin) || !Number.isSafeInteger(Number(uin)) || !name.trim()) {
            throw new Error('replyTo requires a positive safe integer uin and a non-blank name');
        }

        // Match the web editor's mention encoding, not HTML or URL encoding.
        const escapedName = name
            .trim()
            .replace(/%/g, '%25')
            .replace(/,/g, '%2C')
            .replace(/}/g, '%7D');
        replyContent = `@{uin:${uin},nick:${escapedName},auto:1} ${content}`;
    }

    const bkn = getBknFromCookie(cookieObject);
    const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_addreply_ugc?g_tk=${bkn}`;
    const body = new URLSearchParams({
        uin: selfUin,
        hostUin,
        hostuin: selfUin,
        topicId: `${hostUin}_${tid}`,
        commentId: target.commentId,
        commentUin: target.commentUin,
        content: replyContent,
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        ref: '',
        code_version: '1',
        format: 'fs',
        qzreferrer: `https://user.qzone.qq.com/${hostUin}`,
    }).toString();

    log.debug(
        'replyQzoneComment: posting reply (host=%s tid=%s parent=%s)',
        hostUin,
        tid,
        target.commentId,
    );
    const text = await RequestUtil.HttpGetText(url, 'POST', body, {
        Cookie: cookieToString(cookieObject),
        'Content-Type': 'application/x-www-form-urlencoded',
    });
    const response = parseQzoneJson<unknown>(text);

    if (
        response === null ||
        typeof response !== 'object' ||
        Array.isArray(response) ||
        !('code' in response) ||
        typeof response.code !== 'number' ||
        !Number.isInteger(response.code)
    ) {
        throw new Error(
            'invalid qzone reply response: missing or invalid code; check delivery before retrying',
        );
    }

    const subcode = 'subcode' in response ? response.subcode : undefined;

    if (subcode !== undefined && (typeof subcode !== 'number' || !Number.isInteger(subcode))) {
        throw new Error(
            'invalid qzone reply response: invalid subcode; check delivery before retrying',
        );
    }

    if (response.code !== 0 || (subcode !== undefined && subcode !== 0)) {
        const message =
            'message' in response && typeof response.message === 'string' ? response.message : '';
        log.warn(
            'replyQzoneComment: rejected (host=%s tid=%s parent=%s) code=%s subcode=%s',
            hostUin,
            tid,
            target.commentId,
            response.code,
            subcode,
        );
        throw new Error(
            `qzone reply failed: code=${response.code} subcode=${subcode ?? 0} ${message}`.trim(),
        );
    }

    const data = 'data' in response ? response.data : undefined;
    const id =
        data !== null && typeof data === 'object' && !Array.isArray(data) && 'id' in data
            ? data.id
            : undefined;

    if (!(
        (typeof id === 'string' && id.trim() !== '') ||
        (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)
    )) {
        throw new Error(
            'qzone reply accepted but returned an invalid reply ID; check delivery before retrying',
        );
    }

    log.debug(
        'replyQzoneComment: accepted (host=%s tid=%s parent=%s reply=%s)',
        hostUin,
        tid,
        target.commentId,
        id,
    );
    return {
        comment_id: String(id),
        parent_comment_id: target.commentId,
        parent_comment_uin: Number(target.commentUin),
    };
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
    cmtnum?: unknown;
    commentlist?: unknown;
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
export function buildQzoneUpdatePayload(
    detail: RawMsgDetailResponse,
    selfUin: string,
): URLSearchParams {
    if (!detail.tid) {
        throw new Error('qzone msg detail is missing tid');
    }

    const pics = detail.pic ?? [];
    const richtype =
        detail.richtype !== undefined ? Number(detail.richtype) : pics.length === 0 ? '' : 1;
    const richvals: string[] = [];
    const picBoItems: string[] = [];

    for (const pic of pics) {
        const picId = String(pic.pic_id ?? '');

        if (!picId) {
            continue;
        }

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

            if (!picUrl) {
                continue;
            }

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

/** Shared raw detail for reading comments and rebuilding permission updates. */
async function fetchQzoneMsgDetail(
    cookieObject: Record<string, string>,
    targetUin: string,
    tid: string,
    page?: { pos: number; num: number },
): Promise<RawMsgDetailResponse> {
    const bkn = getBknFromCookie(cookieObject);
    const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?${new URLSearchParams(
        {
            tid,
            uin: targetUin,
            t1_source: '1',
            not_trunc_con: '1',
            need_right: '1',
            not_adapt_outpic: '1',
            g_tk: bkn,
            ...(page ? { pos: String(page.pos), num: String(page.num) } : {}),
        },
    ).toString()}`;

    const text = await RequestUtil.HttpGetText(url, 'GET', '', {
        Cookie: cookieToString(cookieObject),
    });
    const data = parseQzoneJson<RawMsgDetailResponse>(text);
    detailObject(data, 'response');

    // Either error field can carry the failure; subcode=0 must not mask code!=0.
    const code =
        data.code !== undefined && data.code !== 0 ? data.code : (data.subcode ?? data.code ?? -1);

    if (code !== 0) {
        log.warn(
            'getQzoneMsgDetail: non-zero code (tid=%s) code=%d msg=%s',
            tid,
            code,
            data.message ?? data.msg,
        );
        throw new Error(
            `qzone msg detail failed: code=${code} ${data.message ?? data.msg ?? ''}`.trim(),
        );
    }

    return data;
}

function detailObject(value: unknown, field: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`invalid qzone msg detail: ${field} must be an object`);
    }

    return value as Record<string, unknown>;
}

function detailString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new Error(`invalid qzone msg detail: ${field} must be a string`);
    }

    return value;
}

function detailInteger(value: unknown, field: string, min = 0): number {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min) {
        throw new Error(`invalid qzone msg detail: ${field} must be an integer >= ${min}`);
    }

    return number;
}

function detailList(value: unknown, field: string): unknown[] {
    if (value === undefined || value === null) {
        return [];
    }

    if (!Array.isArray(value)) {
        throw new Error(`invalid qzone msg detail: ${field} must be an array`);
    }

    return value;
}

function mapQzoneComment(value: Record<string, unknown>, field: string): QzoneCommentReply {
    const id =
        typeof value.tid === 'number'
            ? String(detailInteger(value.tid, `${field}.tid`))
            : detailString(value.tid, `${field}.tid`);

    if (!id) {
        throw new Error(`invalid qzone msg detail: ${field}.tid is empty`);
    }

    return {
        comment_id: id,
        uin: detailInteger(value.uin, `${field}.uin`, 1),
        name: detailString(value.name, `${field}.name`),
        time: detailInteger(value.create_time, `${field}.create_time`),
        content: detailString(value.content, `${field}.content`),
    };
}

/**
 * Read one post and a page of comments, with the inline replies Qzone supplies.
 * Wire fields and pos/num follow SmartHypercube/Qzone-API's Comment / Emotion.load:
 * https://github.com/SmartHypercube/Qzone-API/blob/master/qzone.py
 * Mapping is independent of the update payload; malformed data must not look
 * like a successful empty page. No raw response (private content) is logged.
 */
export async function getQzoneMsgDetail(
    cookieObject: Record<string, string>,
    targetUin: string,
    tid: string,
    pos = 0,
    num = 20,
): Promise<QzoneMsgDetailResult> {
    const data = await fetchQzoneMsgDetail(cookieObject, targetUin, tid, { pos, num });
    const resultTid = detailString(data.tid, 'tid');

    if (!resultTid || resultTid !== tid) {
        throw new Error('invalid qzone msg detail: tid does not match the requested post');
    }

    return {
        tid: resultTid,
        content: detailString(data.content, 'content'),
        comment_num: detailInteger(data.cmtnum, 'cmtnum'),
        comments: detailList(data.commentlist, 'commentlist').map((value, index) => {
            const field = `commentlist[${index}]`;
            const comment = detailObject(value, field);
            const mappedComment = mapQzoneComment(comment, field);
            return {
                ...mappedComment,
                replies: detailList(comment.list_3, `${field}.list_3`).map((reply, replyIndex) => {
                    const replyField = `${field}.list_3[${replyIndex}]`;
                    return {
                        ...mapQzoneComment(detailObject(reply, replyField), replyField),
                        parent_comment_id: mappedComment.comment_id,
                        parent_comment_uin: mappedComment.uin,
                    };
                }),
            };
        }),
    };
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
    const effectiveTargetUins =
        right === 16 || right === 128 ? normalizeTargetUins(targetUins) : '';

    if ((right === 16 || right === 128) && !effectiveTargetUins) {
        throw new Error('target_uins is required when ugc_right is 16 or 128');
    }

    const detail = await fetchQzoneMsgDetail(cookieObject, selfUin, tid);
    const bodyParams = buildQzoneUpdatePayload(detail, selfUin);
    bodyParams.set('ugc_right', String(right));

    if (effectiveTargetUins) {
        bodyParams.set('allow_uins', effectiveTargetUins);
    }

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
        log.warn(
            'updateQzoneMsgRight: non-zero subcode (tid=%s) subcode=%d msg=%s',
            tid,
            data.subcode,
            data.message ?? data.msg,
        );
        throw new Error(
            `qzone update right failed: subcode=${data.subcode} ${data.message ?? data.msg ?? ''}`.trim(),
        );
    }

    if (typeof data.code === 'number' && data.code !== 0) {
        log.warn(
            'updateQzoneMsgRight: non-zero code (tid=%s) code=%d msg=%s',
            tid,
            data.code,
            data.message ?? data.msg,
        );
        throw new Error(
            `qzone update right failed: code=${data.code} ${data.message ?? data.msg ?? ''}`.trim(),
        );
    }

    return { ugc_right: Number(data.ugc_right ?? right) };
}

interface RawQzoneProfileResponse {
    code?: number;
    subcode?: number;
    message?: string;
    data?: {
        spacename?: string;
        desc?: string;
    };
}

export async function getQzoneProfile(
    cookieObject: Record<string, string>,
    selfUin: string,
    targetUin = selfUin,
): Promise<QzoneProfile> {
    const params = new URLSearchParams({
        uin: targetUin,
        vuin: selfUin,
        fupdate: '1',
        rd: String(Math.random()),
        g_tk: getBknFromCookie(cookieObject),
    });
    const url = `https://h5.qzone.qq.com/proxy/domain/base.qzone.qq.com/cgi-bin/user/cgi_userinfo_get_all?${params}`;
    const text = await RequestUtil.HttpGetText(url, 'GET', '', {
        Cookie: cookieToString(cookieObject),
    });
    const response = parseQzoneJson<RawQzoneProfileResponse>(text);

    if (response.code !== 0 || (response.subcode !== undefined && response.subcode !== 0)) {
        throw new Error(
            `qzone profile failed: code=${response.code} subcode=${response.subcode ?? 0} ${response.message ?? ''}`.trim(),
        );
    }

    if (typeof response.data?.spacename !== 'string' || typeof response.data.desc !== 'string') {
        throw new Error('invalid qzone profile response');
    }

    return { name: response.data.spacename, description: response.data.desc };
}

export async function setQzoneProfile(
    cookieObject: Record<string, string>,
    selfUin: string,
    profile: QzoneProfileUpdate,
): Promise<void> {
    const params = new URLSearchParams({ uin: selfUin, pageindex: '3', fupdate: '1' });
    let bitmap = 0;

    // The space settings form uses a field bitmap; omit the separate rich-text signature.
    // https://qzonestyle.gtimg.cn/qzone/v6/setting/profile/scripts/profile.js
    if (profile.name !== undefined) {
        params.set('spacename', profile.name.replaceAll('\r', ''));
        bitmap |= 2048;
    }

    if (profile.description !== undefined) {
        params.set('desc', profile.description.replaceAll('\r', ''));
        bitmap |= 4096;
    }

    params.set('mb', String(bitmap));
    const url = `https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/user/cgi_apply_updateuserinfo_new?g_tk=${getBknFromCookie(cookieObject)}`;
    const text = await RequestUtil.HttpGetText(url, 'POST', params.toString(), {
        Cookie: cookieToString(cookieObject),
        'Content-Type': 'application/x-www-form-urlencoded',
    });
    const response = parseQzoneJson<RawQzoneProfileResponse>(text);

    if (response.code !== 0 || (response.subcode !== undefined && response.subcode !== 0)) {
        throw new Error(
            `qzone profile update failed: code=${response.code} subcode=${response.subcode ?? 0} ${response.message ?? ''}`.trim(),
        );
    }
}
