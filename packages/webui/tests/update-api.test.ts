import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';

afterEach(() => vi.unstubAllGlobals());

describe('update API', () => {
    it('loads, tests and saves mirror selection through authenticated object endpoints', async () => {
        const config = { mode: 'auto', mirror: '', mirrors: ['https://example.com'] } as const;
        const payload = { ...config, mirrors: [...config.mirrors] };
        const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json({ config: payload, results: [] }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const api = createApiClient({ tokenStore: { load: () => 'token', save: () => undefined } });
        await api.update.sources();
        await api.update.testSources(payload);
        await api.update.saveSources(payload);
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            '/api/update/sources',
            '/api/update/sources/test',
            '/api/update/sources',
        ]);

        for (const [, options] of fetchMock.mock.calls) {
            expect(new Headers(options?.headers).get('X-SnowLuma-Token')).toBe('token');
        }

        expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(payload));
        expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('POST');
    });
    it('sends authenticated download and restart requests', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json({ current: '1.0.0', phase: 'ready', version: '2.0.0' }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const api = createApiClient({ tokenStore: { load: () => 'token', save: () => undefined } });
        await api.update.download('2.0.0');
        await api.update.restart();
        await api.update.status();
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            '/api/update/download',
            '/api/update/restart',
            '/api/update/status',
        ]);
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            '/api/update/download',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ version: '2.0.0' }),
                headers: new Headers({
                    'Content-Type': 'application/json',
                    'X-SnowLuma-Token': 'token',
                }),
            }),
        );
    });

    it('surfaces a rejected restart instead of treating it as complete', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({ message: '更新包尚未就绪' }, { status: 409 })),
        );
        const api = createApiClient({ tokenStore: { load: () => 'token', save: () => undefined } });
        await expect(api.update.restart()).rejects.toThrow('更新包尚未就绪');
    });

    it('requests paged releases and explicitly confirms downgrades', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () =>
            Response.json({ current: '2.4.2', target: 'linux-x64', releases: [], nextPage: null }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const api = createApiClient({ tokenStore: { load: () => 'token', save: () => undefined } });
        await api.update.releases();
        await api.update.releases(2, true);
        await api.update.download('1.0.0', { allowDowngrade: true });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            '/api/update/releases?page=1',
            '/api/update/releases?page=2&force=true',
            '/api/update/download',
        ]);
        expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(
            JSON.stringify({ version: '1.0.0', allowDowngrade: true }),
        );

        for (const [, options] of fetchMock.mock.calls) {
            expect(new Headers(options?.headers).get('X-SnowLuma-Token')).toBe('token');
        }
    });

    it('preserves release-list failures for retry instead of returning an empty list', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({ message: 'GitHub unavailable' }, { status: 502 })),
        );
        const api = createApiClient({ tokenStore: { load: () => 'token', save: () => undefined } });
        await expect(api.update.releases()).rejects.toThrow('GitHub unavailable');
    });

    it.each([{}, { current: '2.4.2', target: 'linux-x64', releases: {}, nextPage: null }, []])(
        'rejects malformed release-list responses instead of crashing the picker: %j',
        async (payload) => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => Response.json(payload)),
            );
            const api = createApiClient({
                tokenStore: { load: () => 'token', save: () => undefined },
            });
            await expect(api.update.releases()).rejects.toThrow(/无效/);
        },
    );

    it('accepts complete release entries including unavailable prereleases', async () => {
        const payload = {
            current: '2.4.2',
            target: 'linux-x64',
            nextPage: 2,
            releases: [
                {
                    version: '2.5.0-rc.1',
                    name: 'Preview',
                    notes: null,
                    publishedAt: '2026-11-07T00:00:00Z',
                    htmlUrl: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v2.5.0-rc.1',
                    prerelease: true,
                    available: false,
                    unavailableReason: '缺少当前平台更新包',
                },
            ],
        };
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json(payload)),
        );
        const api = createApiClient({ tokenStore: { load: () => 'token', save: () => undefined } });
        await expect(api.update.releases()).resolves.toEqual(payload);
    });
});
