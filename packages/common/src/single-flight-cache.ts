/** TTL caching and request deduplication to limit repeated upstream requests. */

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

            if (hit && this.now() - hit.at < this.ttlMs) {
                return Promise.resolve(hit.value);
            }
        }

        const existing = this.inflight.get(key);

        if (existing) {
            return existing;
        }

        const load = async (): Promise<V> => {
            const value = await this.load(key);

            if (this.inflight.get(key) === task && this.shouldCache(value)) {
                this.fresh.set(key, { at: this.now(), value });
            }

            return value;
        };

        const task = load().finally(() => {
            if (this.inflight.get(key) === task) {
                this.inflight.delete(key);
            }
        });
        this.inflight.set(key, task);
        return task;
    }

    /** Detach the entry and its pending load; existing callers still settle. */
    invalidate(key: K): void {
        this.fresh.delete(key);
        this.inflight.delete(key);
    }

    /** Detach all entries and pending loads without aborting existing callers. */
    clear(): void {
        this.fresh.clear();
        this.inflight.clear();
    }
}

export function createSingleFlightCache<K, V>(
    opts: SingleFlightCacheOptions<K, V>,
): SingleFlightCache<K, V> {
    return new SingleFlightCache(opts);
}
