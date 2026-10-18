import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';
import { normalizeOneBotConfig } from '../src/lib/onebot-config';

afterEach(() => vi.unstubAllGlobals());

describe('API client configuration', () => {
    const config = normalizeOneBotConfig({});
    const tokenStore = { load: () => 'token', save: vi.fn() };

    it('keeps persisted configuration separate from failed runtime application', async () => {
        const result = {
            config,
            saved: true,
            applied: false,
            online: true,
            errors: [{ name: 'http', phase: 'start', message: 'port in use', at: 1 }],
            message: '配置已保存，应用失败',
        };
        const fetchMock = vi.fn().mockResolvedValue(Response.json(result));
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore });

        await expect(client.config.save('12345', config)).resolves.toEqual(result);
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('rejects a save response without configuration instead of refetching or returning the form', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ success: true, reloaded: true }))
            .mockRejectedValue(new Error('refetch failed'));
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore });

        await expect(client.config.save('12345', config)).rejects.toThrow('无效的配置');
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('reads the configuration from the server envelope', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ config })));
        const client = createApiClient({ tokenStore });

        await expect(client.config.get('12345')).resolves.toEqual(config);
    });

    it('rejects a response without the configuration envelope', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(config)));
        const client = createApiClient({ tokenStore });

        await expect(client.config.get('12345')).rejects.toThrow('无效的配置');
    });
});
