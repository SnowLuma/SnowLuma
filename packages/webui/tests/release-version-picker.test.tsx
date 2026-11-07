import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReleaseVersionPicker } from '../src/components/settings/release-version-picker';
import { releaseAction } from '../src/lib/update-versions';
import type { ReleaseVersion } from '../src/types';

const releases: ReleaseVersion[] = [
    {
        version: '2.4.2',
        name: 'Current',
        notes: 'Release notes',
        publishedAt: '2026-11-07T00:00:00Z',
        htmlUrl: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v2.4.2',
        prerelease: false,
        available: true,
        unavailableReason: null,
    },
    {
        version: '2.3.0',
        name: 'Older',
        notes: null,
        publishedAt: null,
        htmlUrl: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v2.3.0',
        prerelease: false,
        available: false,
        unavailableReason: '缺少 SHA256 校验信息',
    },
    {
        version: '2.5.0-rc.1',
        name: 'Preview',
        notes: null,
        publishedAt: null,
        htmlUrl: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v2.5.0-rc.1',
        prerelease: true,
        available: true,
        unavailableReason: null,
    },
];

function render(overrides: Partial<Parameters<typeof ReleaseVersionPicker>[0]> = {}) {
    return renderToStaticMarkup(
        <ReleaseVersionPicker
            releases={releases}
            current="2.4.2"
            selected="2.4.2"
            loading={false}
            disabled={false}
            hasMore
            error={null}
            onSelect={() => undefined}
            onRefresh={() => undefined}
            onMore={() => undefined}
            onDownload={() => undefined}
            {...overrides}
        />,
    );
}

describe('release version selection', () => {
    it('compares canonical SemVer for reinstall, downgrade and prerelease choices', () => {
        expect(releaseAction('2.4.2', '2.4.2')).toBe('重新安装');
        expect(releaseAction('2.4.1', '2.4.2')).toBe('降级');
        expect(releaseAction('2.5.0-rc.1', '2.4.2')).toBe('升级');
        expect(releaseAction('2.4.2-rc.1', '2.4.2')).toBe('降级');
        const markup = render();
        expect(markup).toContain('重新安装到 v2.4.2');
        expect(markup).toContain('预发布');
        expect(markup).toContain('加载更多');
        expect(markup).toContain('Release notes');
    });

    it('explains unavailable assets and disables their installation', () => {
        const markup = render({ selected: '2.3.0' });
        expect(markup).toContain('缺少 SHA256 校验信息');
        expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>降级到 v2\.3\.0<\/button>/);
    });

    it('preserves an API error with a retry control and no false empty-success state', () => {
        const markup = render({
            releases: [],
            selected: '',
            error: '网络连接失败',
            hasMore: false,
        });
        expect(markup).toContain('role="alert"');
        expect(markup).toContain('网络连接失败');
        expect(markup).toContain('重试加载');
        expect(markup).not.toContain('暂无已发布版本');
    });

    it('blocks installation while another update is staged or downloading', () => {
        expect(render({ disabled: true })).toMatch(
            /<button[^>]*disabled=""[^>]*>重新安装到 v2\.4\.2<\/button>/,
        );
    });

    it('keeps browsing and retry available when installation is unavailable', () => {
        const markup = render({ disabled: true, error: '网络连接失败' });
        expect(markup).toMatch(/<button(?![^>]* disabled=)[^>]*>重试加载<\/button>/);
        expect(markup).toMatch(/<select(?![^>]* disabled=)[^>]*>/);
        expect(markup).toMatch(/<button(?![^>]* disabled=)[^>]*>加载更多<\/button>/);
    });
});
