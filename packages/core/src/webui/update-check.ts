// Advisory update check against the public GitHub Releases API.
//
// Strictly read-only (T0): SnowLuma never downloads or applies anything
// itself — cross-platform self-update is a minefield (Windows locks loaded
// .node/.dll/node.exe, Docker bakes the app into image layers, bare installs
// have no supervisor). We only tell the WebUI that a newer *stable* release
// exists and link the user to it; they download and apply manually.
//
// The result is cached to stay well under GitHub's 60 req/hr unauthenticated
// rate limit, and every failure degrades silently (the UI just shows
// "无法检查更新" rather than nagging).

import { createLogger } from '@snowluma/common/logger';

const log = createLogger('Update');

const LATEST_RELEASE_URL = 'https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest';
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

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
}

function currentVersion(): string {
  return typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : '0.0.0';
}

function isEnabled(): boolean {
  const v = (process.env.SNOWLUMA_UPDATE_CHECK ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/**
 * Compare two dotted versions. Returns >0 if `a` is newer than `b`, <0 if
 * older, 0 if equal. The numeric core (major.minor.patch) compares
 * numerically; a prerelease (`-rc.1`) ranks below its release. Good enough
 * for "is the latest stable strictly newer than what we run" — and avoids
 * pulling in a `semver` runtime dependency (the dist bundle ships none).
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.replace(/^v/, '').split('-', 2);
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // release > prerelease
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

let cache: UpdateCheckResult | null = null;
let inflight: Promise<UpdateCheckResult> | null = null;

async function fetchLatest(current: string): Promise<UpdateCheckResult> {
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
    const res = await fetch(LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `SnowLuma/${current}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ...base, error: `github ${res.status}` };
    const rel = (await res.json()) as GithubRelease;
    const tag = (rel.tag_name ?? '').trim();
    if (!tag) return { ...base, error: 'no tag' };
    const latest = tag.replace(/^v/, '');
    return {
      current,
      latest,
      hasUpdate: compareVersions(latest, current) > 0,
      htmlUrl: rel.html_url ?? null,
      notes: rel.body ? rel.body.slice(0, NOTES_MAX) : null,
      publishedAt: rel.published_at ?? null,
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
export async function getUpdateInfo(force = false): Promise<UpdateCheckResult> {
  const current = currentVersion();
  if (!isEnabled()) {
    return { ...emptyResult(current), error: 'disabled' };
  }
  if (!force && cache && Date.now() - cache.checkedAt < CACHE_TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const result = await fetchLatest(current);
    if (result.error) {
      log.debug('update check failed: %s', result.error);
    } else {
      cache = result; // only cache good results so transient errors retry
      if (result.hasUpdate) log.info('a newer release is available: v%s (running v%s)', result.latest, current);
    }
    return result;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
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
