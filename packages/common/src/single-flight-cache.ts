/** TTL caching and request deduplication to limit repeated upstream requests. */

export interface SingleFlightCacheOptions<K, V> {
    /** Freshness window in ms. Expired values are released even while idle. */
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
    private expiryTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    constructor(opts: SingleFlightCacheOptions<K, V>) {
        this.ttlMs = opts.ttlMs;
        this.load = opts.load;
        this.shouldCache = opts.shouldCache ?? (() => true);
        this.now = opts.now ?? Date.now;
    }

    /** Number of retained values; pending loads are not counted. */
    get size(): number {
        return this.fresh.size;
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
        if (this.disposed) {
            return Promise.reject(new Error('SingleFlightCache is disposed'));
        }

        const hit = this.fresh.get(key);

        if (hit) {
            if (this.now() - hit.at >= this.ttlMs) {
                this.fresh.delete(key);
                this.cancelExpiryIfEmpty();
            } else if (!opts.force) {
                return Promise.resolve(hit.value);
            }
        }

        const existing = this.inflight.get(key);

        if (existing) {
            return existing;
        }

        const load = async (): Promise<V> => {
            const value = await this.load(key);

            if (this.inflight.get(key) === task && this.ttlMs > 0 && this.shouldCache(value)) {
                // Keep insertion order aligned with expiry, including refreshes.
                this.fresh.delete(key);
                this.fresh.set(key, { at: this.now(), value });
                this.scheduleExpiry();
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
        this.cancelExpiryIfEmpty();
    }

    /** Detach all entries and pending loads without aborting existing callers. */
    clear(): void {
        this.fresh.clear();
        this.inflight.clear();
        this.cancelExpiryIfEmpty();
    }

    /** Release this owner's cache permanently; pending callers still settle. */
    dispose(): void {
        this.disposed = true;
        this.clear();
    }

    private cancelExpiryIfEmpty(): void {
        if (this.fresh.size === 0 && this.expiryTimer !== undefined) {
            clearTimeout(this.expiryTimer);
            this.expiryTimer = undefined;
        }
    }

    private scheduleExpiry(): void {
        if (this.expiryTimer !== undefined || !Number.isFinite(this.ttlMs)) {
            return;
        }

        const oldest = this.fresh.values().next().value;

        if (!oldest) {
            return;
        }

        // One unref'ed timer per cache, not one closure/timer per cached roster.
        // Clamp long TTLs to Node's timer range rather than overflowing to 1ms.
        const delay = Math.max(1, Math.min(2 ** 31 - 1, oldest.at + this.ttlMs - this.now()));
        this.expiryTimer = setTimeout(() => {
            this.expiryTimer = undefined;
            const now = this.now();

            for (const [key, entry] of this.fresh) {
                if (now - entry.at < this.ttlMs) {
                    break;
                }

                this.fresh.delete(key);
            }

            this.scheduleExpiry();
        }, delay);
        this.expiryTimer.unref();
    }
}

export function createSingleFlightCache<K, V>(
    opts: SingleFlightCacheOptions<K, V>,
): SingleFlightCache<K, V> {
    return new SingleFlightCache(opts);
}
