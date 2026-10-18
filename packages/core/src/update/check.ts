import { APP_VERSION } from '@snowluma/common/version';
import { compareVersions, parseVersion } from '@snowluma/common/semver';
import { createLogger } from '@snowluma/common/logger';
import { createSingleFlightCache } from '@snowluma/common/single-flight-cache';
import type { UpdateSourceConfig } from '@snowluma/common/update-source';
import { fetchRelease } from './release';
import { readUpdateSource } from './sources';

const log = createLogger('Update');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — comfortably under the rate limit
const FETCH_TIMEOUT_MS = 8_000;
const NOTES_MAX = 4_000; // cap the release-body we hand back to the client

export interface UpdateCheckResult {
    /** The running build's version (no `v` prefix). */
    current: string;
    /** Latest stable release version, or null when the check did not complete. */
    latest: string | null;
    /** True only when `latest` is strictly newer than `current`. */
    hasUpdate: boolean;
    /** GitHub release page URL for the latest release. */
    htmlUrl: string | null;
    /** Release notes (markdown), truncated to {@link NOTES_MAX}. */
    notes: string | null;
    /** ISO timestamp the latest release was published. */
    publishedAt: string | null;
    /** When this result was produced (epoch ms). */
    checkedAt: number;
    /** Set when the check was skipped or failed; the UI degrades silently. */
    error?: string;
}

function isEnabled(): boolean {
    const v = (process.env.SNOWLUMA_UPDATE_CHECK ?? '').trim().toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

// TTL + single-flight: cache good results for CACHE_TTL_MS (well under GitHub's
// 60 req/hr limit) and collapse concurrent checks onto one fetch. Error results
// are intentionally not cached (shouldCache) so the next check retries.
const updateCache = createSingleFlightCache<string, UpdateCheckResult>({
    ttlMs: CACHE_TTL_MS,
    shouldCache: (r) => !r.error,
    load: async (key) => {
        // This key is constructed below from our version and normalized settings.
        const [current, source] = JSON.parse(key) as [string, UpdateSourceConfig];
        const result = await fetchLatest(current, source);

        if (result.error) {
            log.debug('update check failed: %s', result.error);
        } else if (result.hasUpdate) {
            log.info('a newer release is available: v%s (running v%s)', result.latest, current);
        }

        return result;
    },
});

async function fetchLatest(
    current: string,
    source: UpdateSourceConfig,
): Promise<UpdateCheckResult> {
    const base: UpdateCheckResult = {
        current,
        latest: null,
        hasUpdate: false,
        htmlUrl: null,
        notes: null,
        publishedAt: null,
        checkedAt: Date.now(),
    };

    try {
        // `/releases/latest` already excludes drafts and prereleases, so this is
        // stable-channel by construction.
        const { data: rel } = await fetchRelease(
            undefined,
            source,
            `SnowLuma/${current}`,
            FETCH_TIMEOUT_MS,
        );

        if (!rel || typeof rel !== 'object' || Array.isArray(rel)) {
            return { ...base, error: 'invalid release info' };
        }

        const tag =
            'tag_name' in rel && typeof rel.tag_name === 'string' ? rel.tag_name.trim() : '';

        if (!tag) {
            return { ...base, error: 'no tag' };
        }

        const latest = tag.startsWith('v') ? tag.slice(1) : tag;

        if (!parseVersion(latest)) {
            return { ...base, error: 'invalid release version' };
        }

        return {
            current,
            latest,
            hasUpdate: compareVersions(latest, current) > 0,
            htmlUrl: 'html_url' in rel && typeof rel.html_url === 'string' ? rel.html_url : null,
            notes:
                'body' in rel && typeof rel.body === 'string' && rel.body
                    ? rel.body.slice(0, NOTES_MAX)
                    : null,
            publishedAt:
                'published_at' in rel && typeof rel.published_at === 'string'
                    ? rel.published_at
                    : null,
            checkedAt: Date.now(),
        };
    } catch (e) {
        return { ...base, error: e instanceof Error ? e.message : 'network error' };
    }
}

/**
 * Get the update-availability result. Cached for {@link CACHE_TTL_MS}; pass
 * `force` to bypass the cache (the WebUI's "立即检查" button). Never throws —
 * failures come back as a result with `error` set and `hasUpdate: false`, and
 * are not cached so the next check retries.
 */
export async function getUpdateInfo(
    force = false,
    source?: UpdateSourceConfig,
): Promise<UpdateCheckResult> {
    const current = APP_VERSION;

    if (!isEnabled()) {
        return { ...emptyResult(current), error: 'disabled' };
    }

    try {
        return await updateCache.get(JSON.stringify([current, source ?? readUpdateSource()]), {
            force,
        });
    } catch (error) {
        return {
            ...emptyResult(current),
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function emptyResult(current: string): UpdateCheckResult {
    return {
        current,
        latest: null,
        hasUpdate: false,
        htmlUrl: null,
        notes: null,
        publishedAt: null,
        checkedAt: Date.now(),
    };
}
