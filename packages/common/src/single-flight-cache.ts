/**
 * Single-flight + TTL memoization.
 *
 * Concentrates the "don't refetch what's fresh, and don't stampede the same
 * key with concurrent loads" pattern that was hand-rolled (slightly
 * differently each time) across the codebase — e.g. `ContactsApi`'s group
 * member-list cache and the WebUI update-check. Each copy re-implemented the
 * same fiddly trio: a TTL freshness check, an in-flight promise map to
 * de-dupe concurrent callers, and `finally`-cleanup of that map. Getting any
 * of the three subtly wrong (forgetting the `finally`, caching an error,
 * racing the timestamp) is a real hazard — so it lives in one place.
 *
 * The underlying concern is Tencent risk-control: a busy OneBot client can
 * fan out one uncached OIDB fetch per inbound message, and sustained bursts
 * trip a ban. TTL + single-flight collapse that fan-out.
 */

export interface SingleFlightCacheOptions<K, V> {
  /** Freshness window in ms. A cached entry older than this is reloaded. */
  ttlMs: number;
  /** Load the value for a key. Rejections propagate and are never cached. */
  load: (key: K) => Promise<V>;
  /**
   * Decide whether a resolved value should be cached. Default: always.
   * Return `false` to leave an entry uncached (e.g. an error-shaped result the
   * next call should retry) while still de-duping concurrent in-flight callers.
   */
  shouldCache?: (value: V) => boolean;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class SingleFlightCache<K, V> {
  private readonly ttlMs: number;
  private readonly load: (key: K) => Promise<V>;
  private readonly shouldCache: (value: V) => boolean;
  private readonly now: () => number;
  private readonly fresh = new Map<K, { at: number; value: V }>();
  private readonly inflight = new Map<K, Promise<V>>();

  constructor(opts: SingleFlightCacheOptions<K, V>) {
    this.ttlMs = opts.ttlMs;
    this.load = opts.load;
    this.shouldCache = opts.shouldCache ?? (() => true);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Get the value for `key`.
   *
   * - Returns a fresh cached value when the last load was within `ttlMs`.
   * - Otherwise de-dupes concurrent callers onto a single `load()` and caches
   *   the result (subject to `shouldCache`). A rejected `load` propagates to
   *   every joined caller, clears the in-flight slot, and is not cached.
   * - `force` bypasses the freshness check but still joins an in-flight load
   *   rather than starting a second one.
   */
  get(key: K, opts: { force?: boolean } = {}): Promise<V> {
    if (!opts.force) {
      const hit = this.fresh.get(key);
      if (hit && this.now() - hit.at < this.ttlMs) return Promise.resolve(hit.value);
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const task = (async () => {
      try {
        const value = await this.load(key);
        if (this.shouldCache(value)) this.fresh.set(key, { at: this.now(), value });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    return task;
  }

  /** Drop a cached entry. Does not abort an in-flight load. */
  invalidate(key: K): void {
    this.fresh.delete(key);
  }

  /** Drop all cached entries. Does not abort in-flight loads. */
  clear(): void {
    this.fresh.clear();
  }
}

export function createSingleFlightCache<K, V>(
  opts: SingleFlightCacheOptions<K, V>,
): SingleFlightCache<K, V> {
  return new SingleFlightCache(opts);
}
