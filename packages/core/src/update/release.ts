import { parseVersion } from '@snowluma/common/semver';
import type { UpdateSourceConfig } from '@snowluma/common/update-source';
import { RELEASE_ROOT, sourceUrls } from './sources';

export function assetName(version: string, target: string): string {
    const platform = target.replace('win32', 'win');
    return `SnowLuma-v${version}-${platform}-lite.${target.startsWith('win32') ? 'zip' : 'tar.gz'}`;
}

async function readText(response: Response, limit: number): Promise<string> {
    if (!response.body) {
        throw new Error('发布信息为空');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
        for (;;) {
            const { value, done } = await reader.read();

            if (done) {
                break;
            }

            size += value.length;

            if (size > limit) {
                await reader.cancel();
                throw new Error('发布信息过大');
            }

            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    return Buffer.concat(chunks).toString('utf8');
}

function attribute(tag: string, name: string): string | undefined {
    return new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i')
        .exec(tag)?.[2]
        .replaceAll('&amp;', '&')
        .replaceAll('&#39;', "'")
        .replaceAll('&quot;', '"');
}

export function parseLatestReleasePage(html: string) {
    const meta = html
        .match(/<meta\b[^>]*>/gi)
        ?.find((tag) => attribute(tag, 'property') === 'og:url');
    const canonical = meta && attribute(meta, 'content');

    if (!canonical) {
        throw new Error('发布页面缺少版本信息');
    }

    const url = new URL(canonical, 'https://github.com');
    const tag = /^\/SnowLuma\/SnowLuma\/releases\/tag\/([^/]+)$/.exec(url.pathname)?.[1];
    const decoded = tag && decodeURIComponent(tag);
    const version = decoded?.startsWith('v') ? decoded.slice(1) : undefined;
    const parsed = parseVersion(version);

    if (url.origin !== 'https://github.com' || !parsed || parsed.prerelease.length) {
        throw new Error('发布页面不是 SnowLuma 正式版本');
    }

    return { tag_name: `v${parsed.raw}`, html_url: `${RELEASE_ROOT}/tag/v${parsed.raw}` };
}

/** Match the digest in the same asset row; never borrow a neighbouring asset's hash. */
export function parseReleaseAssetsPage(html: string, version: string) {
    const assets: { name: string; size: null; digest: string }[] = [];
    const expected = ['win32-x64', 'linux-x64', 'linux-arm64'].map((target) =>
        assetName(version, target),
    );

    for (const row of html.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) ?? []) {
        const links = row.match(/<a\b[^>]*>/gi) ?? [];
        const name = expected.find((candidate) =>
            links.some((link) => {
                const href = attribute(link, 'href');
                return (
                    href === `/SnowLuma/SnowLuma/releases/download/v${version}/${candidate}` ||
                    href === `${RELEASE_ROOT}/download/v${version}/${candidate}`
                );
            }),
        );

        if (!name) {
            continue;
        }

        const digests = (row.match(/<clipboard-copy\b[^>]*>/gi) ?? [])
            .map((tag) => attribute(tag, 'value'))
            .filter((value): value is string =>
                Boolean(value && /^sha256:[a-f0-9]{64}$/.test(value)),
            );

        if (digests.length !== 1 || assets.some((asset) => asset.name === name)) {
            throw new Error('发布页面缺少唯一的文件校验信息');
        }

        // GitHub renders a rounded size in HTML. Verify the exact digest even
        // when a proxy streams the asset without Content-Length.
        assets.push({ name, size: null, digest: digests[0]! });
    }

    if (!assets.length) {
        throw new Error('发布页面没有可验证的更新包');
    }

    return { tag_name: `v${version}`, assets };
}

export interface ReleaseResult {
    data: unknown;
    fromPage: boolean;
}

export async function fetchRelease(
    version: string | undefined,
    source: UpdateSourceConfig,
    userAgent = 'SnowLuma',
    timeoutMs = 8_000,
): Promise<ReleaseResult> {
    const apiUrl = `https://api.github.com/repos/SnowLuma/SnowLuma/releases/${version ? `tags/v${version}` : 'latest'}`;
    let primaryError: unknown;

    try {
        const response = await fetch(apiUrl, {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': userAgent,
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`GitHub ${response.status}`);
        }

        return {
            data: JSON.parse(await readText(response, 256 * 1024)) as unknown,
            fromPage: false,
        };
    } catch (error) {
        primaryError = error;
    }

    const originalUrl = version
        ? `${RELEASE_ROOT}/expanded_assets/v${version}`
        : `${RELEASE_ROOT}/latest`;
    const controller = new AbortController();

    try {
        // Only a parsed release page can win. Fast errors and HTML interstitials
        // cannot cancel a slower working source.
        // Download proxies often only support assets. Always retain GitHub's
        // release page for version/digest lookup, even with a pinned download mirror.
        const urls = [...new Set([originalUrl, ...sourceUrls(originalUrl, source)])];
        const data = await Promise.any(
            urls.map(async (url) => {
                const response = await fetch(url, {
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
                });

                if (!response.ok) {
                    await response.body?.cancel();
                    throw new Error(`HTTP ${response.status}`);
                }

                const html = await readText(response, 1024 * 1024);
                return version
                    ? parseReleaseAssetsPage(html, version)
                    : parseLatestReleasePage(html);
            }),
        );
        return { data, fromPage: true };
    } catch (error) {
        const failures = error instanceof AggregateError ? error.errors : [error];
        const details = [primaryError, ...failures]
            .filter(Boolean)
            .map((failure: unknown) =>
                failure instanceof Error ? failure.message : String(failure),
            );
        throw new Error(`${[...new Set(details)].join('；')}；请在更新来源中检测或指定可用镜像`);
    } finally {
        controller.abort();
    }
}
