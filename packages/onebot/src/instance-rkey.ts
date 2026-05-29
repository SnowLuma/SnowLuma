import { createLogger } from '@snowluma/common/logger';
import type { DownloadRKeyInfo } from '@snowluma/core/bridge';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { MessageElement } from '@snowluma/protocol/events';

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

  warmUp(bridge: BridgeInterface, uin: string): void {
    this.ensureFresh(bridge).then(
      () => log.info('rkeys loaded: UIN=%s count=%d', uin, this.cache.size),
      (err) => log.warn('failed to load rkeys for UIN %s: %s', uin, err instanceof Error ? err.message : String(err)),
    );
  }

  async resolveImageUrl(bridge: BridgeInterface, element: MessageElement, isGroup: boolean): Promise<string> {
    const url = element.imageUrl ?? '';
    if (!urlNeedsRKey(url)) return url;

    const rkey = await this.findRKey(bridge, isGroup);
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

  private findRKey(bridge: BridgeInterface, isGroup: boolean): Promise<string | null> {
    const primaryType = isGroup ? GROUP_IMAGE_RKEY_TYPE : PRIVATE_IMAGE_RKEY_TYPE;
    return this.findRKeyForType(bridge, primaryType);
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
   * callers onto one in-flight request and backing off for
   * RKEY_REFRESH_COOLDOWN after a failed attempt so a persistently
   * unreachable server isn't hammered once per inbound image. The await is
   * bounded by RKEY_REFRESH_TIMEOUT_MS.
   */
  private async ensureFresh(bridge: BridgeInterface): Promise<void> {
    if (!this.refreshInflight) {
      const now = Math.floor(Date.now() / 1000);
      if (now - this.lastRefreshAttempt < RKEY_REFRESH_COOLDOWN) return;
      this.lastRefreshAttempt = now;
      this.refreshInflight = bridge.apis.contacts.fetchDownloadRKeys()
        .then((rkeys) => { this.updateCache(rkeys); })
        .catch((err) => {
          log.warn('rkey refresh failed: %s', err instanceof Error ? err.message : String(err));
        })
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
