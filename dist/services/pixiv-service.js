/**
 * Pixiv third-party API service.
 *
 * 通过 lolicon.app / obfs.dev 第三方聚合接口获取插画信息。
 * 该模块与运行时（NapCat / SnowLuma）无关，可原样复用。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Author: 希儿 (shiYuPIay)
 */
/** 第三方接口地址。 */
const API_BASE = 'https://api.lolicon.app/setu/v2';
const PIXIV_RANKING_API = 'https://api.obfs.dev/api/pixiv/ranking';
/** 带超时的 fetch，避免第三方接口卡死。 */
async function fetchWithTimeout(url, timeoutMs = 9000, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
/** 从接口返回的多种图片链接中挑选最稳定可下载的 URL。 */
function pickImageUrl(urls) {
    if (!urls)
        return '';
    const candidates = [urls.regular, urls.small, urls.thumb, urls.original].filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
    return candidates[0] ?? '';
}
/** 预检查图片 URL 是否可访问，避免发送合并转发时下载失败。 */
async function isImageUrlAvailable(url) {
    if (!url)
        return false;
    try {
        const headRes = await fetchWithTimeout(url, 5000, { method: 'HEAD' });
        if (headRes.ok)
            return true;
    }
    catch {
        // 某些 CDN 不支持 HEAD，继续尝试 GET 探测。
    }
    try {
        const getRes = await fetchWithTimeout(url, 7000, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
        });
        return getRes.ok;
    }
    catch {
        return false;
    }
}
/** 向第三方接口发起请求，获取插画信息。 */
async function fetchIllusts(params) {
    try {
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(params))
            sp.set(k, String(v));
        const url = `${API_BASE}?${sp.toString()}`;
        const res = await fetchWithTimeout(url, 9000);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const json = (await res.json());
        const data = json?.data ?? [];
        const illusts = [];
        for (const item of data) {
            const pickedUrl = pickImageUrl(item.urls);
            if (!(await isImageUrlAvailable(pickedUrl)))
                continue;
            illusts.push({
                pid: Number(item.pid ?? 0),
                title: String(item.title ?? ''),
                author: String(item.author ?? '未知画师'),
                tags: Array.isArray(item.tags) ? item.tags : [],
                url: pickedUrl,
                r18: Boolean(item.r18),
            });
        }
        return illusts;
    }
    catch (err) {
        console.warn('[pixiv-service] 请求插画接口失败', err);
        return [];
    }
}
/** 根据关键词搜索插画。 */
export async function searchIllusts(tag, num, allowR18) {
    return fetchIllusts({ tag, num, r18: allowR18 ? 1 : 0, size: 'regular' });
}
/** 获取随机推荐插画。 */
export async function recommendIllusts(num, allowR18) {
    return fetchIllusts({ num, r18: allowR18 ? 1 : 0, size: 'regular' });
}
/** 检查第三方接口健康状态。 */
export async function checkApiHealth() {
    const result = { lolicon: false, ranking: false };
    try {
        const res = await fetchWithTimeout(`${API_BASE}?num=1&r18=0&size=small`, 6000);
        result.lolicon = res.ok;
    }
    catch {
        result.lolicon = false;
    }
    try {
        const res = await fetchWithTimeout(`${PIXIV_RANKING_API}?mode=daily&page=1`, 6000);
        result.ranking = res.ok;
    }
    catch {
        result.ranking = false;
    }
    return result;
}
/** 获取 Pixiv 日榜数据。 */
export async function fetchDailyRanking(num = 10) {
    try {
        const limit = Math.min(30, Math.max(1, Number(num) || 10));
        const sp = new URLSearchParams({ mode: 'daily', page: '1' });
        const res = await fetchWithTimeout(`${PIXIV_RANKING_API}?${sp.toString()}`, 9000);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const json = (await res.json());
        const list = Array.isArray(json?.illusts)
            ? json.illusts
            : Array.isArray(json?.data)
                ? json.data
                : [];
        const result = [];
        for (const item of list.slice(0, limit)) {
            const id = Number(item.id ?? item.pid ?? 0);
            const imageUrl = (typeof item.proxyUrl === 'string' && item.proxyUrl) ||
                (typeof item.url === 'string' && item.url) ||
                pickImageUrl(item.urls);
            if (!(await isImageUrlAvailable(imageUrl)))
                continue;
            const tags = Array.isArray(item.tags)
                ? item.tags
                    .map((tag) => (typeof tag === 'string' ? tag : String(tag?.name ?? '')))
                    .filter(Boolean)
                : [];
            result.push({
                id,
                title: String(item.title ?? `作品 ${id || result.length + 1}`),
                author: String(item.user?.name ?? item.author ?? '未知画师'),
                bookmarks: Number(item.totalBookmarks ?? item.bookmarks ?? 0),
                tags,
                proxyUrl: imageUrl,
            });
        }
        return result;
    }
    catch (err) {
        console.warn('[pixiv-service] 获取 Pixiv 日榜失败', err);
        return [];
    }
}
//# sourceMappingURL=pixiv-service.js.map