import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateSourceConfig } from '@snowluma/common/update-source';
import {
    assetName,
    fetchRelease,
    parseLatestReleasePage,
    parseReleaseAssetsPage,
} from '../src/update/release';

const direct: UpdateSourceConfig = { mode: 'direct', mirror: '', mirrors: [] };
const latest =
    '<meta property="og:url" content="https://github.com/SnowLuma/SnowLuma/releases/tag/v2.0.1">';
const digest = `sha256:${'a'.repeat(64)}`;
const name = assetName('2.0.1', 'win32-x64');
const row = `<li><a href="/SnowLuma/SnowLuma/releases/download/v2.0.1/${name}">${name}</a><clipboard-copy value="${digest}"></clipboard-copy></li>`;

afterEach(() => vi.unstubAllGlobals());

describe('existing GitHub release pages', () => {
    it('reads the canonical stable release without a new metadata asset', () => {
        expect(parseLatestReleasePage(latest)).toEqual({
            tag_name: 'v2.0.1',
            html_url: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v2.0.1',
        });
        expect(parseLatestReleasePage(latest.replace('https://github.com', '')).tag_name).toBe(
            'v2.0.1',
        );
    });

    it.each([
        '<html>please sign in</html>',
        latest.replace('github.com', 'unrelated.example'),
        latest.replace('/SnowLuma/SnowLuma/', '/other/project/'),
        latest.replace('v2.0.1', 'v02.0.1'),
        latest.replace('v2.0.1', 'v2.0.1-rc.1'),
    ])('rejects non-release or invalid version pages', (html) => {
        expect(() => parseLatestReleasePage(html)).toThrow();
    });

    it('matches an asset with its own digest, ignoring rounded HTML sizes', () => {
        expect(parseReleaseAssetsPage(row, '2.0.1')).toEqual({
            tag_name: 'v2.0.1',
            assets: [{ name, size: null, digest }],
        });
    });

    it.each([
        row.replace('v2.0.1/', 'v2.0.0/'),
        row.replace(digest, 'unavailable'),
        row + row,
        row.replace(`<clipboard-copy value="${digest}"></clipboard-copy>`, '') +
            `<li><clipboard-copy value="${digest}"></clipboard-copy></li>`,
    ])('rejects absent, ambiguous or neighbouring checksum data', (html) => {
        expect(() => parseReleaseAssetsPage(html, '2.0.1')).toThrow();
    });

    it('falls back from API 403 to the existing release page', async () => {
        const fetchMock = vi.fn<typeof fetch>(async (url) =>
            String(url).includes('api.github.com')
                ? new Response('rate limited', { status: 403 })
                : new Response(latest),
        );
        vi.stubGlobal('fetch', fetchMock);
        expect(await fetchRelease(undefined, direct)).toMatchObject({
            fromPage: true,
            data: { tag_name: 'v2.0.1' },
        });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            'https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest',
            'https://github.com/SnowLuma/SnowLuma/releases/latest',
        ]);
    });

    it('waits for a valid mirror page after fast invalid responses and cancels other requests', async () => {
        let finish!: (response: Response) => void;
        const pending = new Promise<Response>((resolve) => {
            finish = resolve;
        });
        const fetchMock = vi.fn<typeof fetch>(async (url) => {
            if (String(url).startsWith('https://working.example/')) {
                return pending;
            }

            return new Response('HTML challenge');
        });
        vi.stubGlobal('fetch', fetchMock);
        const result = fetchRelease('2.0.1', {
            ...direct,
            mode: 'auto',
            mirrors: ['https://bad.example', 'https://working.example'],
        });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
        finish(new Response(row));
        expect(await result).toMatchObject({
            fromPage: true,
            data: { assets: [{ name, digest }] },
        });
        expect(fetchMock.mock.calls.slice(1).every(([, options]) => options?.signal?.aborted)).toBe(
            true,
        );
    });

    it('keeps direct release lookup when the pinned download mirror cannot serve pages', async () => {
        const fetchMock = vi.fn<typeof fetch>(async (url) =>
            String(url) === 'https://github.com/SnowLuma/SnowLuma/releases/latest'
                ? new Response(latest)
                : new Response('blocked', { status: 403 }),
        );
        vi.stubGlobal('fetch', fetchMock);
        expect(
            await fetchRelease(undefined, {
                ...direct,
                mode: 'mirror',
                mirror: 'https://files.example',
            }),
        ).toMatchObject({ data: { tag_name: 'v2.0.1' } });
    });

    it('rejects oversized release responses', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1))),
        );
        await expect(fetchRelease(undefined, direct)).rejects.toThrow('发布信息过大');
    });
});
