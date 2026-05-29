import { describe, it, expect, vi } from 'vitest';
import { RKeyCache } from '../src/instance-rkey';
import type { MessageElement } from '@snowluma/protocol/events';

// The screenshot URL: a raw QQ-NT multimedia download link with no rkey yet.
const NT_IMAGE_URL = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=ABC';
const GROUP_IMAGE_TYPE = 20;
const PRIVATE_IMAGE_TYPE = 10;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function makeBridge(fetchImpl: () => Promise<unknown[]>) {
  const fetchDownloadRKeys = vi.fn(fetchImpl);
  return { bridge: { apis: { contacts: { fetchDownloadRKeys } } }, fetchDownloadRKeys };
}

function freshGroupRkey(value = 'GROUPKEY') {
  return [{ rkey: value, type: GROUP_IMAGE_TYPE, ttlSeconds: 3600, createTime: nowSec(), storeId: 0 }];
}

function imageEl(): MessageElement {
  return { type: 'image', imageUrl: NT_IMAGE_URL };
}

describe('RKeyCache.resolveImageUrl', () => {
  it('awaits a refresh on a cold cache and appends the rkey', async () => {
    const { bridge, fetchDownloadRKeys } = makeBridge(async () => freshGroupRkey());
    const cache = new RKeyCache();

    const url = await cache.resolveImageUrl(bridge as never, imageEl(), true);

    expect(url).toBe(`${NT_IMAGE_URL}&rkey=GROUPKEY`);
    expect(fetchDownloadRKeys).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent cold-cache lookups into a single fetch', async () => {
    const { bridge, fetchDownloadRKeys } = makeBridge(async () => freshGroupRkey());
    const cache = new RKeyCache();

    const urls = await Promise.all([
      cache.resolveImageUrl(bridge as never, imageEl(), true),
      cache.resolveImageUrl(bridge as never, imageEl(), true),
      cache.resolveImageUrl(bridge as never, imageEl(), true),
    ]);

    expect(urls).toEqual(Array(3).fill(`${NT_IMAGE_URL}&rkey=GROUPKEY`));
    expect(fetchDownloadRKeys).toHaveBeenCalledTimes(1);
  });

  it('serves a still-valid rkey from cache without re-fetching', async () => {
    const { bridge, fetchDownloadRKeys } = makeBridge(async () => freshGroupRkey());
    const cache = new RKeyCache();

    await cache.resolveImageUrl(bridge as never, imageEl(), true);
    await cache.resolveImageUrl(bridge as never, imageEl(), true);

    expect(fetchDownloadRKeys).toHaveBeenCalledTimes(1);
  });

  it('falls back to the unsigned URL (no throw) when the refresh fails', async () => {
    const { bridge, fetchDownloadRKeys } = makeBridge(async () => { throw new Error('oidb down'); });
    const cache = new RKeyCache();

    const url = await cache.resolveImageUrl(bridge as never, imageEl(), true);

    expect(url).toBe(NT_IMAGE_URL);
    expect(fetchDownloadRKeys).toHaveBeenCalledTimes(1);
  });

  it('uses the private rkey type for c2c images', async () => {
    const { bridge } = makeBridge(async () => [
      { rkey: 'PRIVATEKEY', type: PRIVATE_IMAGE_TYPE, ttlSeconds: 3600, createTime: nowSec(), storeId: 0 },
      { rkey: 'GROUPKEY', type: GROUP_IMAGE_TYPE, ttlSeconds: 3600, createTime: nowSec(), storeId: 0 },
    ]);
    const cache = new RKeyCache();

    const url = await cache.resolveImageUrl(bridge as never, imageEl(), false);

    expect(url).toBe(`${NT_IMAGE_URL}&rkey=PRIVATEKEY`);
  });

  it('leaves non-NT URLs untouched and never fetches', async () => {
    const { bridge, fetchDownloadRKeys } = makeBridge(async () => freshGroupRkey());
    const cache = new RKeyCache();
    const el: MessageElement = { type: 'image', imageUrl: 'https://gchat.qpic.cn/foo.jpg' };

    const url = await cache.resolveImageUrl(bridge as never, el, true);

    expect(url).toBe('https://gchat.qpic.cn/foo.jpg');
    expect(fetchDownloadRKeys).not.toHaveBeenCalled();
  });
});
