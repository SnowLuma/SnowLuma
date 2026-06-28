import { describe, it, expect, vi, afterEach } from 'vitest';
import { RKeyCache } from '../src/instance-rkey';
import type { MessageElement } from '@snowluma/protocol/events';

// The screenshot URL: a raw QQ-NT multimedia download link with no rkey yet.
// appid 1407 = group image, 1406 = private/c2c image (see instance-rkey).
const NT_IMAGE_URL = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=ABC';
const NT_PRIVATE_IMAGE_URL = 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=XYZ';
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

function freshBothRkeys() {
  return [
    { rkey: 'PRIVATEKEY', type: PRIVATE_IMAGE_TYPE, ttlSeconds: 3600, createTime: nowSec(), storeId: 0 },
    { rkey: 'GROUPKEY', type: GROUP_IMAGE_TYPE, ttlSeconds: 3600, createTime: nowSec(), storeId: 0 },
  ];
}

function imageEl(): MessageElement {
  return { type: 'image', imageUrl: NT_IMAGE_URL };
}

function privateImageEl(): MessageElement {
  return { type: 'image', imageUrl: NT_PRIVATE_IMAGE_URL };
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

  it('uses the private rkey type for c2c images (appid 1406)', async () => {
    const { bridge } = makeBridge(async () => freshBothRkeys());
    const cache = new RKeyCache();

    const url = await cache.resolveImageUrl(bridge as never, privateImageEl(), false);

    expect(url).toBe(`${NT_PRIVATE_IMAGE_URL}&rkey=PRIVATEKEY`);
  });

  // The scene follows the image's own appid, not the carrying message — the
  // crux of `/get_forward_msg` rkey correctness (issue #74): a c2c image
  // forwarded into a group must still be signed with the private rkey.
  it('signs an appid-1406 image with the private rkey even when isGroup is true', async () => {
    const { bridge } = makeBridge(async () => freshBothRkeys());
    const cache = new RKeyCache();

    const url = await cache.resolveImageUrl(bridge as never, privateImageEl(), true);

    expect(url).toBe(`${NT_PRIVATE_IMAGE_URL}&rkey=PRIVATEKEY`);
  });

  it('signs an appid-1407 image with the group rkey even when isGroup is false', async () => {
    const { bridge } = makeBridge(async () => freshBothRkeys());
    const cache = new RKeyCache();

    const url = await cache.resolveImageUrl(bridge as never, imageEl(), false);

    expect(url).toBe(`${NT_IMAGE_URL}&rkey=GROUPKEY`);
  });

  it('falls back to the isGroup scene when the URL carries no appid', async () => {
    const noAppidUrl = 'https://multimedia.nt.qq.com.cn/download?fileid=NOAPPID';
    const { bridge } = makeBridge(async () => freshBothRkeys());
    const cache = new RKeyCache();

    const url = await cache.resolveImageUrl(
      bridge as never, { type: 'image', imageUrl: noAppidUrl }, true,
    );

    expect(url).toBe(`${noAppidUrl}&rkey=GROUPKEY`);
  });

  // #156: a transient empty/failed fetch must self-heal in seconds, not 30s.
  // An empty cache uses the short RKEY_EMPTY_COOLDOWN (10s), so a retry ~11s
  // later refetches — under the 30s steady-state backoff it would not.
  it('retries before the 30s cooldown while the cache holds no usable rkey', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(1_700_000_000_000));
      let calls = 0;
      const { bridge, fetchDownloadRKeys } = makeBridge(
        async () => (++calls === 1 ? [] : freshGroupRkey()),
      );
      const cache = new RKeyCache();

      const url1 = await cache.resolveImageUrl(bridge as never, imageEl(), true);
      expect(url1).toBe(NT_IMAGE_URL); // empty fetch → bare URL

      vi.setSystemTime(new Date(1_700_000_000_000 + 11_000)); // +11s: past 10s empty-cooldown, inside 30s
      const url2 = await cache.resolveImageUrl(bridge as never, imageEl(), true);

      expect(url2).toBe(`${NT_IMAGE_URL}&rkey=GROUPKEY`);
      expect(fetchDownloadRKeys).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT refetch within 30s once a usable rkey is cached', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(1_700_000_000_000));
      const { bridge, fetchDownloadRKeys } = makeBridge(async () => freshGroupRkey());
      const cache = new RKeyCache();

      await cache.resolveImageUrl(bridge as never, imageEl(), true);
      vi.setSystemTime(new Date(1_700_000_000_000 + 15_000)); // +15s, inside 30s backoff
      await cache.resolveImageUrl(bridge as never, imageEl(), true);

      expect(fetchDownloadRKeys).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

describe('RKeyCache remote fallback (#156)', () => {
  const SERVER = 'https://rkey.example/r';

  function stubFetch(payload: unknown, status = 200) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status }),
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is off by default: never contacts a server, leaves the URL bare', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { bridge } = makeBridge(async () => []); // native yields nothing
    const cache = new RKeyCache(); // no config → fallback off

    const url = await cache.resolveImageUrl(bridge as never, imageEl(), true);

    expect(url).toBe(NT_IMAGE_URL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to the configured server when the native fetch is empty', async () => {
    const fetchSpy = stubFetch({
      group_rkey: '&rkey=FBGROUP', private_rkey: '&rkey=FBPRIV', expired_time: nowSec() + 3600,
    });
    const { bridge } = makeBridge(async () => []);
    const cache = new RKeyCache({ fallbackServers: [SERVER] });

    const url = await cache.resolveImageUrl(bridge as never, imageEl(), true);

    expect(url).toBe(`${NT_IMAGE_URL}&rkey=FBGROUP`);
    expect(fetchSpy).toHaveBeenCalledWith(SERVER, expect.anything());
  });

  it('signs c2c images with the fallback private rkey', async () => {
    stubFetch({ group_rkey: '&rkey=FBGROUP', private_rkey: '&rkey=FBPRIV', expired_time: nowSec() + 3600 });
    const { bridge } = makeBridge(async () => []);
    const cache = new RKeyCache({ fallbackServers: [SERVER] });

    const url = await cache.resolveImageUrl(bridge as never, privateImageEl(), false);

    expect(url).toBe(`${NT_PRIVATE_IMAGE_URL}&rkey=FBPRIV`);
  });

  it('accepts an OneBot { retcode, data } wrapper and bare (unprefixed) tokens', async () => {
    stubFetch({ retcode: 0, data: { group_rkey: 'BAREKEY', private_rkey: '', expired_time: nowSec() + 3600 } });
    const { bridge } = makeBridge(async () => []);
    const cache = new RKeyCache({ fallbackServers: [SERVER] });

    const url = await cache.resolveImageUrl(bridge as never, imageEl(), true);

    expect(url).toBe(`${NT_IMAGE_URL}&rkey=BAREKEY`);
  });

  it('does not hit any server when the native fetch already returned a rkey', async () => {
    const fetchSpy = stubFetch({ group_rkey: '&rkey=FBGROUP', expired_time: nowSec() + 3600 });
    const { bridge } = makeBridge(async () => freshGroupRkey());
    const cache = new RKeyCache({ fallbackServers: [SERVER] });

    const url = await cache.resolveImageUrl(bridge as never, imageEl(), true);

    expect(url).toBe(`${NT_IMAGE_URL}&rkey=GROUPKEY`); // native rkey, not fallback
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tries the next server when the first one fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ group_rkey: '&rkey=SECOND', expired_time: nowSec() + 3600 }), { status: 200 }));
    const { bridge } = makeBridge(async () => []);
    const cache = new RKeyCache({ fallbackServers: ['https://a.example/r', 'https://b.example/r'] });

    const url = await cache.resolveImageUrl(bridge as never, imageEl(), true);

    expect(url).toBe(`${NT_IMAGE_URL}&rkey=SECOND`);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('leaves the URL bare when every fallback server fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const { bridge } = makeBridge(async () => []);
    const cache = new RKeyCache({ fallbackServers: [SERVER] });

    const url = await cache.resolveImageUrl(bridge as never, imageEl(), true);

    expect(url).toBe(NT_IMAGE_URL);
  });

  // Hot-reload wire: manager.reloadGlobalSettings → instance.applyGlobalSettings
  // → rkeyCache.setFallbackServers. Verify the new list actually takes effect.
  // (Fake Date so the 2nd lookup clears the empty-cache refresh cooldown.)
  it('setFallbackServers turns the fallback on for a cache that started with none', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(1_700_000_000_000));
      const fetchSpy = stubFetch({ group_rkey: '&rkey=HOTGROUP', expired_time: 1_700_000_000 + 3600 });
      const { bridge } = makeBridge(async () => []);
      const cache = new RKeyCache(); // starts OFF (no servers)

      const before = await cache.resolveImageUrl(bridge as never, imageEl(), true);
      expect(before).toBe(NT_IMAGE_URL);     // bare — fallback off
      expect(fetchSpy).not.toHaveBeenCalled();

      cache.setFallbackServers([SERVER]);    // hot-reload pushes a new endpoint
      vi.setSystemTime(new Date(1_700_000_000_000 + 11_000)); // clear the 10s empty-cooldown

      const after = await cache.resolveImageUrl(bridge as never, imageEl(), true);
      expect(after).toBe(`${NT_IMAGE_URL}&rkey=HOTGROUP`);
      expect(fetchSpy).toHaveBeenCalledWith(SERVER, expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });
});
