import { createLogger } from '@snowluma/common/logger';
import type { DownloadRKeyInfo } from '@snowluma/core/bridge';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { MessageElement } from '@snowluma/protocol/events';
import type { RKeyConfig } from './types';

const log = createLogger('OneBot');

interface CachedRKey {
  value: string;
  type: number;
  createTime: number;
  ttlSeconds: number;
  expiresAt: number;
}

const RKEY_REFRESH_SKEW = 60;
const RKEY_REFRESH_COOLDOWN = 30;
// When the cache holds NO usable image rkey, the alternative to refreshing is
// handing out a bare URL the CDN rejects with `invalid rkey` (issue #156). So
// retry far more eagerly than the 30s steady-state backoff — but still throttled
// so a persistently-failing fetch isn't hammered once per inbound image.
const RKEY_EMPTY_COOLDOWN = 10;
// Upper bound on how long URL resolution may block on a refresh round-trip.
// A stuck packet send must never wedge message conversion — past this we
// fall back to whatever the cache holds (possibly nothing).
const RKEY_REFRESH_TIMEOUT_MS = 5000;
const PRIVATE_IMAGE_RKEY_TYPE = 10;
const GROUP_IMAGE_RKEY_TYPE = 20;
const PRIVATE_VIDEO_RKEY_TYPE = 12;
const GROUP_VIDEO_RKEY_TYPE = 22;
const PRIVATE_PTT_RKEY_TYPE = 14;
const GROUP_PTT_RKEY_TYPE = 24;
const FALLBACK_IMAGE_RKEY_TYPE = 2;

export class RKeyCache {
  private cache = new Map<number, CachedRKey>();
  private lastRefreshAttempt = 0;
  private refreshInflight: Promise<void> | null = null;
  /** Opt-in remote rkey endpoints; empty = feature off (the default). */
  private fallbackServers: string[];

  constructor(config?: RKeyConfig) {
    this.fallbackServers = config?.fallbackServers ?? [];
  }

  /** Replace the fallback endpoint list (global-config hot-reload). */
  setFallbackServers(servers: string[]): void {
    this.fallbackServers = servers;
  }

  warmUp(bridge: BridgeInterface, uin: string): void {
    this.ensureFresh(bridge).then(
      () => log.info('rkeys loaded: UIN=%s count=%d', uin, this.cache.size),
      (err) => log.warn('failed to load rkeys for UIN %s: %s', uin, err instanceof Error ? err.message : String(err)),
    );
  }

  async resolveImageUrl(bridge: BridgeInterface, element: MessageElement, isGroup: boolean): Promise<string> {
    const url = element.imageUrl ?? '';
    if (!urlNeedsRKey(url)) return url;

    // The rkey scene must follow the IMAGE's own upload context, not the
    // message currently carrying it. A c2c image forwarded into a group
    // keeps its original c2c fileid/appid (1406); signing it with the
    // group rkey just because the forward node looks like a group message
    // yields `invalid rkey` on download. So derive the scene from the
    // appid baked into the URL, and only fall back to `isGroup` when the
    // URL carries no recognised appid (legacy gchat / unknown shapes).
    // Mirrors NapCat's getImageUrlFromParsedUrl (appid 1406 → private,
    // 1407 → group).
    const primaryType = imageRKeyTypeFromUrl(url)
      ?? (isGroup ? GROUP_IMAGE_RKEY_TYPE : PRIVATE_IMAGE_RKEY_TYPE);
    const rkey = await this.findRKeyForType(bridge, primaryType);
    if (!rkey) return url;

    const cleanRKey = stripRKeyPrefix(rkey);
    const separator = url.includes('?') ? '&rkey=' : '?rkey=';
    return url + separator + encodeURIComponent(cleanRKey);
  }

  async resolveMediaUrl(bridge: BridgeInterface, element: MessageElement, isGroup: boolean): Promise<string> {
    const url = element.url ?? '';
    if (!url || !urlNeedsRKey(url)) return url;

    const mediaType = element.type;
    let primaryType: number;
    if (mediaType === 'video') {
      primaryType = isGroup ? GROUP_VIDEO_RKEY_TYPE : PRIVATE_VIDEO_RKEY_TYPE;
    } else if (mediaType === 'record') {
      primaryType = isGroup ? GROUP_PTT_RKEY_TYPE : PRIVATE_PTT_RKEY_TYPE;
    } else {
      // For file types, try image rkeys as a fallback (file URLs typically use image rkeys)
      primaryType = isGroup ? GROUP_IMAGE_RKEY_TYPE : PRIVATE_IMAGE_RKEY_TYPE;
    }

    const rkey = await this.findRKeyForType(bridge, primaryType);
    if (!rkey) return url;

    const cleanRKey = stripRKeyPrefix(rkey);
    const separator = url.includes('?') ? '&rkey=' : '?rkey=';
    return url + separator + encodeURIComponent(cleanRKey);
  }

  private updateCache(rkeys: DownloadRKeyInfo[]): void {
    const now = Math.floor(Date.now() / 1000);
    for (const rk of rkeys) {
      if (!rk.rkey || !rk.type) continue;
      const baseTime = rk.createTime || now;
      const ttl = rk.ttlSeconds || 3600;
      this.cache.set(rk.type, {
        value: rk.rkey,
        type: rk.type,
        createTime: rk.createTime,
        ttlSeconds: rk.ttlSeconds,
        expiresAt: baseTime + ttl,
      });
    }
  }

  /** True when at least one common image rkey (group or private) is cached and
   *  still valid — i.e. we can sign a typical image without a fresh fetch. */
  private hasUsableRkey(): boolean {
    return this.findInCache(GROUP_IMAGE_RKEY_TYPE) !== null
      || this.findInCache(PRIVATE_IMAGE_RKEY_TYPE) !== null;
  }

  /** Pull a still-valid rkey out of the cache, or null if missing/expiring. */
  private findInCache(primaryType: number): string | null {
    const now = Math.floor(Date.now() / 1000);
    const tryFind = (type: number): string | null => {
      const cached = this.cache.get(type);
      if (!cached || !cached.value) return null;
      if (cached.expiresAt !== 0 && now + RKEY_REFRESH_SKEW >= cached.expiresAt) return null;
      return cached.value;
    };
    return tryFind(primaryType) ?? tryFind(FALLBACK_IMAGE_RKEY_TYPE);
  }

  private async findRKeyForType(bridge: BridgeInterface, primaryType: number): Promise<string | null> {
    const cached = this.findInCache(primaryType);
    if (cached) return cached;

    // Cache miss or inside the expiry skew: block on a fresh fetch rather
    // than hand back a URL with a stale/absent rkey — the CDN rejects those
    // with `{"retcode":-5503010,"retmsg":"invalid rkey"}`. Mirrors NapCat's
    // getImageUrl path, which does `if (isExpired()) await refreshRkey()`
    // before building the URL instead of refreshing in the background.
    await this.ensureFresh(bridge);
    return this.findInCache(primaryType);
  }

  /**
   * Refresh the rkey cache via OIDB 0x9067_202, coalescing concurrent
   * callers onto one in-flight request and backing off (RKEY_REFRESH_COOLDOWN
   * when a usable rkey is held, RKEY_EMPTY_COOLDOWN while none is) so a
   * persistently-failing fetch isn't hammered once per inbound image. The await
   * is bounded by RKEY_REFRESH_TIMEOUT_MS.
   */
  private async ensureFresh(bridge: BridgeInterface): Promise<void> {
    if (!this.refreshInflight) {
      const now = Math.floor(Date.now() / 1000);
      // Back off hard once we hold a usable rkey; retry quickly while we don't,
      // so a transient empty/failed fetch self-heals in seconds, not 30s (#156).
      const cooldown = this.hasUsableRkey() ? RKEY_REFRESH_COOLDOWN : RKEY_EMPTY_COOLDOWN;
      if (now - this.lastRefreshAttempt < cooldown) return;
      this.lastRefreshAttempt = now;
      this.refreshInflight = this.runRefresh(bridge)
        .finally(() => { this.refreshInflight = null; });
    }

    const inflight = this.refreshInflight;
    if (!inflight) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, RKEY_REFRESH_TIMEOUT_MS); });
    try {
      await Promise.race([inflight, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** One refresh round: native OIDB fetch, then — only if that left us without
   *  a usable image rkey AND fallback servers are configured — the remote
   *  fallback. Never throws; logs and degrades to whatever the cache holds. */
  private async runRefresh(bridge: BridgeInterface): Promise<void> {
    try {
      const rkeys = await bridge.apis.contacts.fetchDownloadRKeys();
      this.updateCache(rkeys);
    } catch (err) {
      log.warn('rkey refresh failed: %s', err instanceof Error ? err.message : String(err));
    }
    if (this.fallbackServers.length > 0 && !this.hasUsableRkey()) {
      await this.refreshFromFallback();
    }
  }

  /** Ask each configured fallback server in turn for an rkey, stopping at the
   *  first that yields one. Populates the group/private image rkey types. */
  private async refreshFromFallback(): Promise<void> {
    for (const server of this.fallbackServers) {
      try {
        const data = await fetchFallbackRkey(server);
        if (!data) continue;
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = data.expiredTime > now ? data.expiredTime : now + 3600;
        if (data.groupRkey) this.setFallbackRkey(GROUP_IMAGE_RKEY_TYPE, data.groupRkey, expiresAt);
        if (data.privateRkey) this.setFallbackRkey(PRIVATE_IMAGE_RKEY_TYPE, data.privateRkey, expiresAt);
        if (data.groupRkey || data.privateRkey) {
          log.info('rkey loaded from fallback server %s', server);
          return;
        }
      } catch (err) {
        log.warn('rkey fallback server %s failed: %s', server, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private setFallbackRkey(type: number, value: string, expiresAt: number): void {
    this.cache.set(type, { value, type, createTime: 0, ttlSeconds: 0, expiresAt });
  }
}

interface FallbackRkeyData {
  groupRkey: string;
  privateRkey: string;
  /** Absolute unix-seconds expiry (0 when the server omits it). */
  expiredTime: number;
}

/** Fetch + parse one fallback server's response. Accepts the bare
 *  `{ group_rkey, private_rkey, expired_time }` shape and an OneBot
 *  `{ retcode, data: {...} }` wrapper. Returns null when neither rkey is
 *  present. The stored values keep any leading `&rkey=`/`?rkey=` — resolveImageUrl
 *  strips it before re-appending, so both prefixed and bare tokens work. */
async function fetchFallbackRkey(server: string): Promise<FallbackRkeyData | null> {
  const res = await fetch(server, { signal: AbortSignal.timeout(RKEY_REFRESH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  let body = await res.json() as Record<string, unknown>;
  if (body && typeof body === 'object' && 'retcode' in body && isRecord(body.data)) {
    body = body.data;
  }
  if (!isRecord(body)) return null;
  const groupRkey = typeof body.group_rkey === 'string' ? body.group_rkey : '';
  const privateRkey = typeof body.private_rkey === 'string' ? body.private_rkey : '';
  if (!groupRkey && !privateRkey) return null;
  const expiredTime = typeof body.expired_time === 'number' ? body.expired_time : 0;
  return { groupRkey, privateRkey, expiredTime };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// QQ-NT download appids embedded in the image URL query string. The scene
// they encode is a property of the image (where it was uploaded), so they
// outrank the carrying message's group/private context — see resolveImageUrl.
const APPID_PRIVATE_IMAGE = '1406';
const APPID_GROUP_IMAGE = '1407';

/** Map the `appid` baked into an NT download URL to its rkey type. Returns
 *  null when the URL carries no recognised appid, leaving the caller to fall
 *  back to the message's group/private context. */
function imageRKeyTypeFromUrl(url: string): number | null {
  const match = url.match(/[?&]appid=(\d+)/);
  if (!match) return null;
  if (match[1] === APPID_PRIVATE_IMAGE) return PRIVATE_IMAGE_RKEY_TYPE;
  if (match[1] === APPID_GROUP_IMAGE) return GROUP_IMAGE_RKEY_TYPE;
  return null;
}

function urlNeedsRKey(url: string): boolean {
  if (!url || url.includes('rkey=')) return false;
  if (url.includes('gchat.qpic.cn')) return false;
  return url.includes('multimedia.nt.qq.com.cn') ||
    url.includes('.nt.qq.com.cn') ||
    url.includes('/download');
}

function stripRKeyPrefix(rkey: string): string {
  for (const prefix of ['&rkey=', '?rkey=']) {
    if (rkey.startsWith(prefix)) return rkey.slice(prefix.length);
  }
  return rkey;
}
