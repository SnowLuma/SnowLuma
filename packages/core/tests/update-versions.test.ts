import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateSourceConfig } from '@snowluma/common/update-source';
import { assetName } from '../src/update/release';

const settings = vi.hoisted(() => ({
    source: { mode: 'direct', mirror: '', mirrors: [] } as UpdateSourceConfig,
}));

vi.mock('../src/update/sources', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/update/sources')>()),
    readUpdateSource: () => settings.source,
}));

const digest = `sha256:${'a'.repeat(64)}`;

function release(version = '2.0.0', target = 'linux-x64') {
    return {
        tag_name: `v${version}`,
        name: `SnowLuma v${version}`,
        body: 'Release notes',
        published_at: '2026-11-01T00:00:00Z',
        draft: false,
        prerelease: false,
        assets: [{ name: assetName(version, target), size: 1024, digest }],
    };
}

beforeEach(() => {
    vi.resetModules();
    settings.source = { mode: 'direct', mirror: '', mirrors: [] };
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('published release versions', () => {
    it('keeps official stable and preview versions in API order, excluding drafts and invalid tags', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json([
                { ...release('2.1.0-rc.1'), prerelease: true },
                release(),
                { ...release('1.9.0'), draft: true },
                { ...release('1.8.0'), tag_name: 'nightly' },
                { ...release('1.7.0'), tag_name: '1.7.0' },
                { ...release('1.6.0'), tag_name: 'v01.6.0' },
                { ...release('1.5.0'), tag_name: 'v1.5.0\n' },
            ]),
        );
        vi.stubGlobal('fetch', fetchMock);
        const { getReleaseVersions } = await import('../src/update/versions');
        const result = await getReleaseVersions('1.0.0', 'linux-x64');
        expect(result).toEqual({
            current: '1.0.0',
            target: 'linux-x64',
            releases: [
                {
                    version: '2.1.0-rc.1',
                    name: 'SnowLuma v2.1.0-rc.1',
                    notes: 'Release notes',
                    publishedAt: '2026-11-01T00:00:00Z',
                    htmlUrl: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v2.1.0-rc.1',
                    prerelease: true,
                    available: true,
                    unavailableReason: null,
                },
                {
                    version: '2.0.0',
                    name: 'SnowLuma v2.0.0',
                    notes: 'Release notes',
                    publishedAt: '2026-11-01T00:00:00Z',
                    htmlUrl: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v2.0.0',
                    prerelease: false,
                    available: true,
                    unavailableReason: null,
                },
            ],
            nextPage: null,
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.github.com/repos/SnowLuma/SnowLuma/releases?per_page=15&page=1',
            expect.objectContaining({
                headers: expect.objectContaining({ 'User-Agent': 'SnowLuma/1.0.0' }),
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it.each([
        { assets: [] },
        { assets: release('2.0.0', 'win32-x64').assets },
        { assets: [{ ...release().assets[0]!, digest: null }] },
        { assets: [{ ...release().assets[0]!, size: 0 }] },
        { assets: [{ ...release().assets[0]!, size: 1.5 }] },
        { assets: [release().assets[0]!, release().assets[0]!] },
    ])(
        'marks a release without a unique verifiable platform package unavailable: %j',
        async (patch) => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => Response.json([{ ...release(), ...patch }])),
            );
            const { getReleaseVersions } = await import('../src/update/versions');
            const result = await getReleaseVersions('1.0.0', 'linux-x64');
            expect(result.releases).toHaveLength(1);
            expect(result.releases[0]).toMatchObject({
                available: false,
                unavailableReason: expect.any(String),
            });
        },
    );

    it('reports source checkouts as unavailable and limits notes without trusting release URLs', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                Response.json([
                    {
                        ...release('2.0.0+build.01'),
                        name: '',
                        body: 'n'.repeat(5_000),
                        html_url: 'https://unrelated.example/release',
                    },
                ]),
            ),
        );
        const { getReleaseVersions } = await import('../src/update/versions');
        const result = await getReleaseVersions('1.0.0', null);
        expect(result.releases[0]).toMatchObject({
            name: 'v2.0.0+build.01',
            notes: 'n'.repeat(4_000),
            htmlUrl: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v2.0.0%2Bbuild.01',
            available: false,
            unavailableReason: '在线切换版本仅支持发行包',
        });
    });

    it('continues pagination after a full filtered page and stops at the page limit', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                Response.json(Array.from({ length: 15 }, () => ({ ...release(), draft: true }))),
            ),
        );
        const { getReleaseVersions } = await import('../src/update/versions');
        expect(await getReleaseVersions('1.0.0', 'linux-x64', 2)).toMatchObject({
            releases: [],
            nextPage: 3,
        });
        expect(await getReleaseVersions('1.0.0', 'linux-x64', 100)).toMatchObject({
            releases: [],
            nextPage: null,
        });
    });

    it('caches by version, platform, page and source, and shares forced refreshes', async () => {
        let finish!: (response: Response) => void;
        const pending = new Promise<Response>((resolve) => {
            finish = resolve;
        });
        const fetchMock = vi.fn<typeof fetch>(async () => Response.json([release()]));
        vi.stubGlobal('fetch', fetchMock);
        const { getReleaseVersions } = await import('../src/update/versions');
        await getReleaseVersions('1.0.0', 'linux-x64');
        await getReleaseVersions('1.0.0', 'linux-x64');
        expect(fetchMock).toHaveBeenCalledOnce();
        fetchMock.mockImplementationOnce(() => pending);
        const first = getReleaseVersions('1.0.0', 'linux-x64', 1, true);
        const second = getReleaseVersions('1.0.0', 'linux-x64', 1, true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        finish(Response.json([release('2.0.1')]));
        expect(await first).toEqual(await second);
        await getReleaseVersions('1.0.1', 'linux-x64');
        await getReleaseVersions('1.0.0', 'win32-x64');
        await getReleaseVersions('1.0.0', 'linux-x64', 2);
        settings.source = { mode: 'mirror', mirror: 'https://mirror.example', mirrors: [] };
        await getReleaseVersions('1.0.0', 'linux-x64');
        expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('expires cached release pages after ten minutes', async () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const fetchMock = vi.fn(async () => Response.json([release()]));
        vi.stubGlobal('fetch', fetchMock);
        const { getReleaseVersions } = await import('../src/update/versions');
        await getReleaseVersions('1.0.0', 'linux-x64');
        now += 10 * 60_000 + 1;
        await getReleaseVersions('1.0.0', 'linux-x64');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('tries configured mirrors after direct failure and ignores fast invalid mirror results', async () => {
        settings.source = {
            mode: 'auto',
            mirror: '',
            mirrors: ['https://invalid.example', 'https://working.example'],
        };
        const fetchMock = vi.fn<typeof fetch>(async (url) => {
            if (String(url).startsWith('https://working.example/')) {
                return Response.json([release()]);
            }

            return String(url).includes('invalid.example')
                ? new Response('<html>challenge</html>')
                : new Response('rate limited', { status: 403 });
        });
        vi.stubGlobal('fetch', fetchMock);
        const { getReleaseVersions } = await import('../src/update/versions');
        expect((await getReleaseVersions('1.0.0', 'linux-x64')).releases).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
    });

    it.each([
        {},
        [null],
        [{ ...release(), draft: undefined }],
        [{ ...release(), published_at: null }],
        [{ ...release(), assets: undefined }],
        Array.from({ length: 16 }, () => release()),
    ])('rejects malformed release data instead of returning an empty list: %j', async (data) => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json(data)),
        );
        const { getReleaseVersions } = await import('../src/update/versions');
        await expect(getReleaseVersions('1.0.0', 'linux-x64')).rejects.toThrow('读取发布版本失败');
    });

    it('does not cache failed or oversized responses', async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response('blocked', { status: 403 }))
            .mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)))
            .mockResolvedValueOnce(Response.json([release()]));
        vi.stubGlobal('fetch', fetchMock);
        const { getReleaseVersions } = await import('../src/update/versions');
        await expect(getReleaseVersions('1.0.0', 'linux-x64')).rejects.toThrow('HTTP 403');
        await expect(getReleaseVersions('1.0.0', 'linux-x64')).rejects.toThrow('发布信息过大');
        expect((await getReleaseVersions('1.0.0', 'linux-x64')).releases).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it.each([0, -1, 101, 1.5, NaN, Infinity])(
        'rejects an out-of-bounds page %s before fetching',
        async (page) => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);
            const { getReleaseVersions } = await import('../src/update/versions');
            await expect(getReleaseVersions('1.0.0', 'linux-x64', page)).rejects.toThrow('页码');
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );
});
