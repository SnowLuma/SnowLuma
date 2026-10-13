import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';

const tokenStore = { load: () => 'test-token', save: () => undefined };

afterEach(() => vi.unstubAllGlobals());

describe('API response JSON', () => {
    it.each(['<html>proxy error</html>', '', 'null', '[]', '42'])(
        'rejects an invalid successful response instead of returning an empty list (%j)',
        async (body) => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
            const client = createApiClient({ tokenStore });

            await expect(client.processes.list()).rejects.toMatchObject({
                status: 502,
                code: 'INVALID_RESPONSE',
            });
        },
    );

    it('preserves the HTTP status when an error response is not JSON', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response('<html>unavailable</html>', {
                    status: 503,
                    statusText: 'Service Unavailable',
                }),
            ),
        );
        const client = createApiClient({ tokenStore });

        await expect(client.processes.list()).rejects.toMatchObject({
            status: 503,
            message: 'Service Unavailable',
        });
    });

    it('does not turn a failed JSON body read into successful empty data', async () => {
        const failure = new Error('response stream interrupted');
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(failure) }),
        );
        const client = createApiClient({ tokenStore });

        await expect(client.processes.list()).rejects.toBe(failure);
    });
});
