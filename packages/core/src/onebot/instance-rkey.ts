import type { MessageElement } from '../bridge/events';
import type { DownloadRKeyInfo } from '../bridge/bridge';
import type { BridgeInterface } from '../bridge/bridge-interface';
import { createLogger } from '../utils/logger';

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

  warmUp(bridge: BridgeInterface, uin: string): void {
    bridge.fetchDownloadRKeys().then(
      (rkeys) => {
        this.updateCache(rkeys);
        log.info('rkeys loaded: UIN=%s count=%d', uin, rkeys.length);
      },
      (err) => {
        log.warn('failed to load rkeys for UIN %s: %s', uin, err instanceof Error ? err.message : String(err));
      },
    );
  }

  resolveImageUrl(bridge: BridgeInterface, element: MessageElement, isGroup: boolean): string {
    const url = element.imageUrl ?? '';
    if (!urlNeedsRKey(url)) return url;

    const rkey = this.findRKey(bridge, isGroup);
    if (!rkey) return url;

    const cleanRKey = stripRKeyPrefix(rkey);
    const separator = url.includes('?') ? '&rkey=' : '?rkey=';
    return url + separator + encodeURIComponent(cleanRKey);
  }

  /**
   * Resolve a URL for video/record/file media elements.
   * Appends the correct RKey type based on media kind and group/private context.
   */
  resolveMediaUrl(bridge: BridgeInterface, element: MessageElement, isGroup: boolean): string {
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

    const rkey = this.findRKeyForType(bridge, primaryType);
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

  private findRKey(bridge: BridgeInterface, isGroup: boolean): string | null {
    const primaryType = isGroup ? GROUP_IMAGE_RKEY_TYPE : PRIVATE_IMAGE_RKEY_TYPE;
    return this.findRKeyForType(bridge, primaryType);
  }

  private findRKeyForType(bridge: BridgeInterface, primaryType: number): string | null {
    const now = Math.floor(Date.now() / 1000);

    const tryFind = (type: number): string | null => {
      const cached = this.cache.get(type);
      if (!cached || !cached.value) return null;
      if (cached.expiresAt !== 0 && now + RKEY_REFRESH_SKEW >= cached.expiresAt) return null;
      return cached.value;
    };

    let result = tryFind(primaryType) ?? tryFind(FALLBACK_IMAGE_RKEY_TYPE);
    if (result) return result;

    // Refresh check cooldown
    if (now - this.lastRefreshAttempt < RKEY_REFRESH_COOLDOWN) return null;
    this.lastRefreshAttempt = now;

    // Schedule async refresh
    bridge.fetchDownloadRKeys().then(
      (rkeys) => this.updateCache(rkeys),
      () => { /* ignore */ },
    );

    // Try again (won't be ready yet for this call, but future calls will benefit)
    result = tryFind(primaryType) ?? tryFind(FALLBACK_IMAGE_RKEY_TYPE);
    return result;
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
