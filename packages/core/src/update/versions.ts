import { parseVersion } from '@snowluma/common/semver';
import { createSingleFlightCache } from '@snowluma/common/single-flight-cache';
import type { UpdateSourceConfig } from '@snowluma/common/update-source';
import { assetName, readText } from './release';
import { readUpdateSource, RELEASE_ROOT, sourceUrls } from './sources';

const PAGE_SIZE = 15;
const MAX_PAGE = 100;
const NOTES_MAX = 4_000;
const FETCH_TIMEOUT_MS = 8_000;

export interface ReleaseVersion {
    version: string;
    name: string;
    notes: string | null;
    publishedAt: string | null;
    htmlUrl: string;
    prerelease: boolean;
    available: boolean;
    unavailableReason: string | null;
}

export interface ReleaseVersionsResult {
    current: string;
    target: string | null;
    releases: ReleaseVersion[];
    nextPage: number | null;
}

function parseRelease(value: unknown, target: string | null): ReleaseVersion | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('发布版本列表无效');
    }

    if (!('draft' in value) || typeof value.draft !== 'boolean') {
        throw new Error('发布版本列表缺少发布状态');
    }

    if (value.draft) {
        return null;
    }

    const tag = 'tag_name' in value && typeof value.tag_name === 'string' ? value.tag_name : '';
    const version = tag.startsWith('v') ? tag.slice(1) : '';
    const parsed = parseVersion(version);

    if (!parsed) {
        return null;
    }

    if (
        !('prerelease' in value) ||
        typeof value.prerelease !== 'boolean' ||
        !('published_at' in value) ||
        typeof value.published_at !== 'string' ||
        !Number.isFinite(Date.parse(value.published_at)) ||
        !('assets' in value) ||
        !Array.isArray(value.assets)
    ) {
        throw new Error('发布版本列表缺少有效的发布信息');
    }

    const name =
        'name' in value && typeof value.name === 'string' && value.name.trim()
            ? value.name.slice(0, 200)
            : tag;
    let unavailableReason: string | null = null;

    if (target === null) {
        unavailableReason = '在线切换版本仅支持发行包';
    } else {
        const expected = assetName(version, target);
        const assets = value.assets.filter(
            (asset: unknown) =>
                asset !== null &&
                typeof asset === 'object' &&
                'name' in asset &&
                asset.name === expected,
        );
        const asset: unknown = assets[0];

        if (assets.length !== 1) {
            unavailableReason = '此版本没有当前平台的唯一更新包';
        } else if (
            !asset ||
            typeof asset !== 'object' ||
            !('size' in asset) ||
            typeof asset.size !== 'number' ||
            !Number.isSafeInteger(asset.size) ||
            asset.size <= 0 ||
            !('digest' in asset) ||
            typeof asset.digest !== 'string' ||
            !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
        ) {
            unavailableReason = '更新包缺少有效的大小或 SHA256 校验信息';
        }
    }

    return {
        version,
        name,
        notes:
            'body' in value && typeof value.body === 'string' && value.body
                ? value.body.slice(0, NOTES_MAX)
                : null,
        publishedAt: value.published_at,
        htmlUrl: `${RELEASE_ROOT}/tag/${encodeURIComponent(tag)}`,
        prerelease: value.prerelease || parsed.prerelease.length > 0,
        available: unavailableReason === null,
        unavailableReason,
    };
}

async function fetchVersions(
    current: string,
    target: string | null,
    page: number,
    source: UpdateSourceConfig,
): Promise<ReleaseVersionsResult> {
    const apiUrl = `https://api.github.com/repos/SnowLuma/SnowLuma/releases?per_page=${PAGE_SIZE}&page=${page}`;
    const controller = new AbortController();

    const request = async (url: string): Promise<ReleaseVersionsResult> => {
        const response = await fetch(url, {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': `SnowLuma/${current}`,
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        });

        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`HTTP ${response.status}`);
        }

        const data: unknown = JSON.parse(await readText(response, 2 * 1024 * 1024));

        if (!Array.isArray(data) || data.length > PAGE_SIZE) {
            throw new Error('发布版本列表无效');
        }

        const releases: ReleaseVersion[] = [];
        const seen = new Set<string>();

        for (const value of data) {
            const release = parseRelease(value, target);

            if (release && !seen.has(release.version)) {
                releases.push(release);
                seen.add(release.version);
            }
        }

        return {
            current,
            target,
            releases,
            // Filtering drafts and non-version tags must not hide a following page.
            nextPage: data.length === PAGE_SIZE && page < MAX_PAGE ? page + 1 : null,
        };
    };

    let primaryError: unknown;

    try {
        try {
            return await request(apiUrl);
        } catch (error) {
            primaryError = error;
        }

        const mirrors = [...new Set(sourceUrls(apiUrl, source))].filter((url) => url !== apiUrl);

        if (!mirrors.length) {
            throw primaryError;
        }

        return await Promise.any(mirrors.map(request));
    } catch (error) {
        const failures = error instanceof AggregateError ? error.errors : [error];
        const details = [primaryError, ...failures]
            .filter(Boolean)
            .map((failure: unknown) =>
                failure instanceof Error ? failure.message : String(failure),
            );
        throw new Error(
            `读取发布版本失败：${[...new Set(details)].join('；')}；请检查网络或更新来源`,
        );
    } finally {
        controller.abort();
    }
}

const versionsCache = createSingleFlightCache<string, ReleaseVersionsResult>({
    ttlMs: 10 * 60_000,
    load: (key) => {
        const [current, target, page, source] = JSON.parse(key) as [
            string,
            string | null,
            number,
            UpdateSourceConfig,
        ];
        return fetchVersions(current, target, page, source);
    },
});

/** Fetch a bounded page of official releases; failed requests are never cached. */
export async function getReleaseVersions(
    current: string,
    target: string | null,
    page = 1,
    force = false,
): Promise<ReleaseVersionsResult> {
    if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) {
        throw new Error('版本列表页码必须为 1 到 100 的整数');
    }

    return versionsCache.get(JSON.stringify([current, target, page, readUpdateSource()]), {
        force,
    });
}
