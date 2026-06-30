/**
 * Pixiv third-party API service.
 *
 * 通过 lolicon.app / obfs.dev 第三方聚合接口获取插画信息。
 * 该模块与运行时（NapCat / SnowLuma）无关，可原样复用。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Author: 希儿 (shiYuPIay)
 */

import type { ApiHealth, PixivIllust, PixivRankingIllust } from '../types.js';

/** 第三方接口地址。 */
const API_BASE = 'https://api.lolicon.app/setu/v2';
const PIXIV_RANKING_API = 'https://api.obfs.dev/api/pixiv/ranking';

/** 带超时的 fetch，避免第三方接口卡死。 */
async function fetchWithTimeout(url: string, timeoutMs = 9000, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 从接口返回的多种图片链接中挑选最稳定可下载的 URL。 */
function pickImageUrl(
  urls?: { regular?: string; small?: string; thumb?: string; original?: string } | null,
): string {
  if (!urls) return '';
  const candidates = [urls.regular, urls.small, urls.thumb, urls.original].filter(
    (u): u is string => typeof u === 'string' && /^https?:\/\//.test(u),
  );
  return candidates[0] ?? '';
}

/** 预检查图片 URL 是否可访问，避免发送合并转发时下载失败。 */
async function isImageUrlAvailable(url: string): Promise<boolean> {
  if (!url) return false;
  try {
    const headRes = await fetchWithTimeout(url, 5000, { method: 'HEAD' });
    if (headRes.ok) return true;
  } catch {
    // 某些 CDN 不支持 HEAD，继续尝试 GET 探测。
  }
  try {
    const getRes = await fetchWithTimeout(url, 7000, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    });
    return getRes.ok;
  } catch {
    return false;
  }
}

/** lolicon 接口返回的原始数据项。 */
interface LoliconItem {
  pid?: number;
  title?: string;
  author?: string;
  tags?: string[];
  r18?: boolean;
  urls?: { regular?: string; small?: string; thumb?: string; original?: string } | null;
}

/** 向第三方接口发起请求，获取插画信息。 */
async function fetchIllusts(params: Record<string, unknown>): Promise<PixivIllust[]> {
  try {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) sp.set(k, String(v));
    const url = `${API_BASE}?${sp.toString()}`;
    const res = await fetchWithTimeout(url, 9000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: LoliconItem[] };
    const data = json?.data ?? [];
    const illusts: PixivIllust[] = [];
    for (const item of data) {
      const pickedUrl = pickImageUrl(item.urls);
      if (!(await isImageUrlAvailable(pickedUrl))) continue;
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
  } catch (err) {
    console.warn('[pixiv-service] 请求插画接口失败', err);
    return [];
  }
}

/** 根据关键词搜索插画。 */
export async function searchIllusts(tag: string, num: number, allowR18: boolean): Promise<PixivIllust[]> {
  return fetchIllusts({ tag, num, r18: allowR18 ? 1 : 0, size: 'regular' });
}

/** 获取随机推荐插画。 */
export async function recommendIllusts(num: number, allowR18: boolean): Promise<PixivIllust[]> {
  return fetchIllusts({ num, r18: allowR18 ? 1 : 0, size: 'regular' });
}

/** 检查第三方接口健康状态。 */
export async function checkApiHealth(): Promise<ApiHealth> {
  const result: ApiHealth = { lolicon: false, ranking: false };
  try {
    const res = await fetchWithTimeout(`${API_BASE}?num=1&r18=0&size=small`, 6000);
    result.lolicon = res.ok;
  } catch {
    result.lolicon = false;
  }
  try {
    const res = await fetchWithTimeout(`${PIXIV_RANKING_API}?mode=daily&page=1`, 6000);
    result.ranking = res.ok;
  } catch {
    result.ranking = false;
  }
  return result;
}

/** 日榜接口返回的 tag 结构。 */
interface RankingTag {
  name?: string;
}

/** 日榜接口返回的原始数据项。 */
interface RankingItem {
  id?: number;
  pid?: number;
  title?: string;
  author?: string;
  url?: string;
  proxyUrl?: string;
  totalBookmarks?: number;
  bookmarks?: number;
  user?: { name?: string } | null;
  tags?: (string | RankingTag)[];
  urls?: { regular?: string; small?: string; thumb?: string; original?: string } | null;
}

/** 获取 Pixiv 日榜数据。 */
export async function fetchDailyRanking(num = 10): Promise<PixivRankingIllust[]> {
  try {
    const limit = Math.min(30, Math.max(1, Number(num) || 10));
    const sp = new URLSearchParams({ mode: 'daily', page: '1' });
    const res = await fetchWithTimeout(`${PIXIV_RANKING_API}?${sp.toString()}`, 9000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { illusts?: RankingItem[]; data?: RankingItem[] };
    const list: RankingItem[] = Array.isArray(json?.illusts)
      ? json.illusts
      : Array.isArray(json?.data)
        ? json.data
        : [];

    const result: PixivRankingIllust[] = [];
    for (const item of list.slice(0, limit)) {
      const id = Number(item.id ?? item.pid ?? 0);
      const imageUrl =
        (typeof item.proxyUrl === 'string' && item.proxyUrl) ||
        (typeof item.url === 'string' && item.url) ||
        pickImageUrl(item.urls);
      if (!(await isImageUrlAvailable(imageUrl))) continue;
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
  } catch (err) {
    console.warn('[pixiv-service] 获取 Pixiv 日榜失败', err);
    return [];
  }
}
