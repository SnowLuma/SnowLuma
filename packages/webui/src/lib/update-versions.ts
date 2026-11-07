import { compareVersions, parseVersion } from '@snowluma/common/semver';
import type { ReleaseVersion, ReleaseVersionsResult } from '@/types';

export function releaseAction(version: string, current: string) {
    const comparison = compareVersions(version, current);
    return comparison < 0 ? '降级' : comparison === 0 ? '重新安装' : '升级';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRelease(value: unknown): value is ReleaseVersion {
    return (
        isRecord(value) &&
        parseVersion(value.version) !== null &&
        typeof value.name === 'string' &&
        (value.notes === null || typeof value.notes === 'string') &&
        (value.publishedAt === null ||
            (typeof value.publishedAt === 'string' &&
                Number.isFinite(Date.parse(value.publishedAt)))) &&
        value.htmlUrl ===
            `https://github.com/SnowLuma/SnowLuma/releases/tag/${encodeURIComponent(`v${String(value.version)}`)}` &&
        typeof value.prerelease === 'boolean' &&
        typeof value.available === 'boolean' &&
        (value.unavailableReason === null || typeof value.unavailableReason === 'string')
    );
}

export function parseReleaseVersions(value: unknown): ReleaseVersionsResult {
    if (
        !isRecord(value) ||
        typeof value.current !== 'string' ||
        !parseVersion(value.current) ||
        !(
            value.target === null ||
            (typeof value.target === 'string' &&
                /^(win32-x64|linux-(x64|arm64))$/.test(value.target))
        ) ||
        !Array.isArray(value.releases) ||
        value.releases.length > 15 ||
        !value.releases.every(isRelease) ||
        !(
            value.nextPage === null ||
            (typeof value.nextPage === 'number' &&
                Number.isSafeInteger(value.nextPage) &&
                value.nextPage >= 2 &&
                value.nextPage <= 100)
        )
    ) {
        throw new Error('服务端返回了无效的发行版本列表，请重试');
    }

    return {
        current: value.current,
        target: value.target,
        releases: value.releases,
        nextPage: value.nextPage,
    };
}
