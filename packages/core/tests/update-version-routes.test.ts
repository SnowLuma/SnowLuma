import { describe, expect, it, vi } from 'vitest';
import type { UpdateService } from '../src/update/service';
import { updateRoutes } from '../src/webui/update-routes';

function routes() {
    const service = {
        status: vi
            .fn<UpdateService['status']>()
            .mockReturnValue({ current: '2.0.0', phase: 'idle' }),
        releases: vi.fn<UpdateService['releases']>().mockResolvedValue({
            current: '2.0.0',
            target: 'linux-x64',
            releases: [],
            nextPage: null,
        }),
        start: vi.fn<UpdateService['start']>(),
        restart: vi.fn<UpdateService['restart']>(),
    } satisfies UpdateService;
    return { service, app: updateRoutes(service, vi.fn()) };
}

describe('release version routes', () => {
    it('returns a release-page object and forwards explicit refresh', async () => {
        const { app, service } = routes();
        const first = await app.request('/releases');
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({
            current: '2.0.0',
            target: 'linux-x64',
            releases: [],
            nextPage: null,
        });
        expect(service.releases).toHaveBeenNthCalledWith(1, 1, false);
        expect((await app.request('/releases?page=2&force=true')).status).toBe(200);
        expect(service.releases).toHaveBeenNthCalledWith(2, 2, true);
        expect((await app.request('/releases?page=100&force=false')).status).toBe(200);
        expect(service.releases).toHaveBeenNthCalledWith(3, 100, false);
    });

    it.each([
        'page=',
        'page=0',
        'page=01',
        'page=-1',
        'page=101',
        'page=1.5',
        'page=Infinity',
        'page=1e1',
        'page=%201',
        'page=1&page=2',
        'force=',
        'force=1',
        'force=True',
        'force=true&force=false',
    ])('rejects invalid query parameters without fetching: %s', async (query) => {
        const { app, service } = routes();
        const response = await app.request(`/releases?${query}`);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ message: expect.any(String) });
        expect(service.releases).not.toHaveBeenCalled();
    });

    it('reports upstream failure with a JSON error rather than an empty page', async () => {
        const { app, service } = routes();
        service.releases.mockRejectedValue(new Error('GitHub rate limited'));
        const response = await app.request('/releases');
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ message: 'GitHub rate limited' });
    });

    it.each([true, false])(
        'forwards explicit downgrade confirmation %s',
        async (allowDowngrade) => {
            const { app, service } = routes();
            const response = await app.request('/download', {
                method: 'POST',
                body: JSON.stringify({ version: '1.9.0', allowDowngrade }),
            });
            expect(response.status).toBe(202);
            expect(service.start).toHaveBeenCalledWith('1.9.0', { allowDowngrade });
        },
    );

    it.each(['true', 1, null, {}, []])(
        'rejects non-boolean downgrade confirmation: %j',
        async (allowDowngrade) => {
            const { app, service } = routes();
            const response = await app.request('/download', {
                method: 'POST',
                body: JSON.stringify({ version: '1.9.0', allowDowngrade }),
            });
            expect(response.status).toBe(400);
            expect(service.start).not.toHaveBeenCalled();
        },
    );
});
