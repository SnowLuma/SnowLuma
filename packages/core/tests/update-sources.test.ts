import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_UPDATE_SOURCE, sourceUrls, testUpdateSources } from '../src/update/sources';
import type { UpdateSourceConfig } from '@snowluma/common/update-source';

const config: UpdateSourceConfig = {
    mode: 'auto',
    mirror: '',
    mirrors: [
        'https://good.example',
        'https://html.example',
        'https://fake.example',
        'https://failed.example',
    ],
};
afterEach(() => vi.unstubAllGlobals());

describe('update mirror selection', () => {
    it('uses direct, ordered fallback or only the pinned mirror for downloads', () => {
        const url = 'https://github.com/project/asset';
        expect(sourceUrls(url, config)).toEqual([
            url,
            ...config.mirrors.map((mirror) => `${mirror}/${url}`),
        ]);
        expect(sourceUrls(url, { ...config, mode: 'direct' })).toEqual([url]);
        expect(
            sourceUrls(url, { ...config, mode: 'mirror', mirror: 'https://pinned.example/proxy' }),
        ).toEqual([`https://pinned.example/proxy/${url}`]);
        expect(DEFAULT_UPDATE_SOURCE.mirrors.length).toBeGreaterThanOrEqual(7);
    });

    it('probes actual archive prefixes, rejects HTML even with a binary content type, and cancels bodies', async () => {
        const cancelled = vi.fn();
        const signature =
            process.platform === 'win32' ? [0x50, 0x4b, 0x03, 0x04] : [0x1f, 0x8b, 0x08, 0];
        const fetchMock = vi.fn<typeof fetch>(async (url) => {
            if (String(url).startsWith('https://html.example')) {
                return new Response('<html>blocked</html>', {
                    headers: { 'Content-Type': 'text/html' },
                });
            }

            if (String(url).startsWith('https://fake.example')) {
                return new Response('<html>blocked</html>', {
                    headers: { 'Content-Type': 'application/octet-stream' },
                });
            }

            if (String(url).startsWith('https://failed.example')) {
                return new Response('blocked', { status: 403 });
            }

            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(signature));
                    },
                    cancel: cancelled,
                }),
            );
        });
        vi.stubGlobal('fetch', fetchMock);
        const results = await testUpdateSources(config);
        expect(
            results
                .filter((result) => result.available)
                .map((result) => result.mirror)
                .sort(),
        ).toEqual(['', 'https://good.example']);
        expect(results.filter((result) => !result.available)).toHaveLength(3);
        expect(results.at(-1)?.available).toBe(false);
        expect(cancelled).toHaveBeenCalledTimes(2);
        expect(
            fetchMock.mock.calls.every(
                ([, options]) =>
                    options?.headers &&
                    'Range' in options.headers &&
                    options.headers.Range === 'bytes=0-3',
            ),
        ).toBe(true);
    });
});
