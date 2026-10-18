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
});
