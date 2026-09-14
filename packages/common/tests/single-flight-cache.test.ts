import { describe, it, expect, vi } from 'vitest';
import { createSingleFlightCache } from '../src/single-flight-cache';

/** A promise whose resolve/reject is exposed, for driving single-flight races. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('SingleFlightCache', () => {
  it('caches within the TTL and reloads once expired', async () => {
    let clock = 1000;
    const load = vi.fn(async (k: string) => `${k}@${clock}`);
    const cache = createSingleFlightCache<string, string>({ ttlMs: 100, load, now: () => clock });

    expect(await cache.get('a')).toBe('a@1000');
    clock = 1050; // still fresh (< 100)
    expect(await cache.get('a')).toBe('a@1000');
    expect(load).toHaveBeenCalledTimes(1);

    clock = 1101; // 101ms since store → expired
    expect(await cache.get('a')).toBe('a@1101');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('de-dupes concurrent callers onto a single load (single-flight)', async () => {
    const d = deferred<string>();
    const load = vi.fn(() => d.promise);
    const cache = createSingleFlightCache<string, string>({ ttlMs: 1000, load });

    const p1 = cache.get('k');
    const p2 = cache.get('k');
    const p3 = cache.get('k');
    expect(load).toHaveBeenCalledTimes(1); // only one load in flight

    d.resolve('v');
    expect(await Promise.all([p1, p2, p3])).toEqual(['v', 'v', 'v']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keys independently — different keys load separately', async () => {
    const load = vi.fn(async (k: number) => k * 2);
    const cache = createSingleFlightCache<number, number>({ ttlMs: 1000, load });
    expect(await cache.get(1)).toBe(2);
    expect(await cache.get(2)).toBe(4);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('force bypasses the freshness check but still joins an in-flight load', async () => {
    let clock = 0;
    const load = vi.fn(async (k: string) => `${k}@${clock}`);
    const cache = createSingleFlightCache<string, string>({ ttlMs: 10_000, load, now: () => clock });

    expect(await cache.get('a')).toBe('a@0'); // 1 load, cached fresh
    clock = 5; // still fresh
    expect(await cache.get('a', { force: true })).toBe('a@5'); // force → reload despite fresh
    expect(load).toHaveBeenCalledTimes(2);

    // force still single-flights: two concurrent forced gets share one load.
    const d = deferred<string>();
    load.mockImplementationOnce(() => d.promise);
    const p1 = cache.get('a', { force: true });
    const p2 = cache.get('a', { force: true });
    expect(load).toHaveBeenCalledTimes(3); // not 4
    d.resolve('shared');
    expect(await Promise.all([p1, p2])).toEqual(['shared', 'shared']);
  });

  it('shouldCache=false leaves the entry uncached (next call reloads) but still de-dupes in-flight', async () => {
    let n = 0;
    const load = vi.fn(async () => ({ error: true as boolean, n: ++n }));
    const cache = createSingleFlightCache({ ttlMs: 10_000, load, shouldCache: (v) => !v.error });

    // concurrent callers still share one load...
    const [a, b] = await Promise.all([cache.get('k'), cache.get('k')]);
    expect(a).toEqual({ error: true, n: 1 });
    expect(b).toEqual({ error: true, n: 1 });
    expect(load).toHaveBeenCalledTimes(1);

    // ...but nothing was cached, so the next call reloads.
    expect(await cache.get('k')).toEqual({ error: true, n: 2 });
    expect(load).toHaveBeenCalledTimes(2);

    // a good result IS cached.
    load.mockImplementationOnce(async () => ({ error: false, n: ++n }));
    const good = await cache.get('k');
    expect(good).toEqual({ error: false, n: 3 });
    expect(await cache.get('k')).toEqual({ error: false, n: 3 }); // served from cache
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('a rejected load propagates to all joined callers, is not cached, and clears in-flight', async () => {
    let attempt = 0;
    const load = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error('boom');
      return 'ok';
    });
    const cache = createSingleFlightCache<string, string>({ ttlMs: 10_000, load });

    const p1 = cache.get('k');
    const p2 = cache.get('k');
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom'); // same in-flight, same rejection
    expect(load).toHaveBeenCalledTimes(1);

    // in-flight cleared + not cached → next call retries and succeeds.
    expect(await cache.get('k')).toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidate drops a cached entry; clear drops all', async () => {
    const load = vi.fn(async (k: string) => k.toUpperCase());
    const cache = createSingleFlightCache<string, string>({ ttlMs: 10_000, load });
    await cache.get('a');
    await cache.get('b');
    expect(load).toHaveBeenCalledTimes(2);

    cache.invalidate('a');
    await cache.get('a'); // reloads
    await cache.get('b'); // still cached
    expect(load).toHaveBeenCalledTimes(3);

    cache.clear();
    await cache.get('a');
    await cache.get('b');
    expect(load).toHaveBeenCalledTimes(5);
  });
});
