import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';

const sessionToken = 'webui-session-token';
const proxyAuthorization = 'Basic cHJveHk6cGFzc3dvcmQ=';
const proxyHeaderEntries: [string, string][] = [['Authorization', proxyAuthorization]];
const tokenStore = { load: () => sessionToken, save: vi.fn() };

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('WebUI authentication behind a Basic-auth proxy', () => {
    it('does not clear a new session when an old request returns 401', async () => {
        const old = Promise.withResolvers<Response>();
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) =>
                url === '/api/login'
                    ? Promise.resolve(Response.json({ token: 'new-token' }))
                    : old.promise,
            ),
        );
        const save = vi.fn();
        const onUnauthorized = vi.fn();
        const client = createApiClient({
            tokenStore: { load: () => sessionToken, save },
            onUnauthorized,
        });
        const request = client.request('/api/old');
        await client.login('password');
        old.resolve(new Response(null, { status: 401 }));
        await request;
        expect(save.mock.calls).toEqual([['new-token']]);
        expect(onUnauthorized).not.toHaveBeenCalled();
    });
    it.each([
        { kind: 'object', headers: { Authorization: proxyAuthorization } },
        { kind: 'Headers', headers: new Headers({ Authorization: proxyAuthorization }) },
        { kind: 'tuples', headers: proxyHeaderEntries },
    ])('preserves supplied proxy credentials from $kind', async ({ headers }) => {
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            const sent = new Headers(init?.headers);

            if (sent.get('authorization') !== proxyAuthorization) {
                return new Response(null, { status: 401 });
            }

            return new Response(null, {
                status: sent.get('x-snowluma-token') === sessionToken ? 204 : 403,
            });
        });
        vi.stubGlobal('fetch', fetchMock);
        const onUnauthorized = vi.fn();
        const client = createApiClient({ tokenStore, onUnauthorized });

        const response = await client.request('/api/auth/state', { headers });

        expect(response.status).toBe(204);
        expect(onUnauthorized).not.toHaveBeenCalled();
        expect(tokenStore.save).not.toHaveBeenCalled();
    });

    it('leaves browser-managed proxy authentication available on JSON requests', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ list: [] }));
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore });

        await expect(client.qqList()).resolves.toEqual([]);

        const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
        expect(headers.get('x-snowluma-token')).toBe(sessionToken);
        expect(headers.has('authorization')).toBe(false);
    });

    it('authenticates multipart uploads without replacing the browser multipart boundary', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ config: {} }));
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore });
        const file = new File(['image'], 'background.png', { type: 'image/png' });

        await client.ui.uploadBackground(file);

        const [url, init] = fetchMock.mock.calls[0]!;
        const headers = new Headers(init?.headers);
        expect(url).toBe('/api/ui/background');
        expect(headers.get('x-snowluma-token')).toBe(sessionToken);
        expect(headers.has('authorization')).toBe(false);
        expect(headers.has('content-type')).toBe(false);
        expect(init?.body).toBeInstanceOf(FormData);
        expect((init?.body as FormData).get('file')).toBe(file);
    });

    it('authenticates streamed action requests without overriding proxy authentication', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response('data: {"type":"done"}\n\n', {
                headers: { 'Content-Type': 'text/event-stream' },
            }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore });
        const onFrame = vi.fn();

        await client.debug.invokeStream('12345', 'test_action', {}, onFrame);

        const [url, init] = fetchMock.mock.calls[0]!;
        const headers = new Headers(init?.headers);
        expect(url).toBe('/api/debug/invoke-stream');
        expect(headers.get('x-snowluma-token')).toBe(sessionToken);
        expect(headers.has('authorization')).toBe(false);
        expect(headers.get('content-type')).toBe('application/json');
        expect(onFrame).toHaveBeenCalledWith({ type: 'done' });
    });

    it('authenticates XHR uploads without overriding proxy authentication', async () => {
        const headers = new Headers();
        const send = vi.fn();
        class UploadRequest {
            upload = {};
            responseType = '';
            status = 200;
            response = { path: '/tmp/uploaded-file', size: 4 };
            onload?: () => void;
            open = vi.fn();
            setRequestHeader(name: string, value: string) {
                headers.set(name, value);
            }
            send(file: File) {
                send(file);
                this.onload?.();
            }
        }
        vi.stubGlobal('XMLHttpRequest', UploadRequest);
        const client = createApiClient({ tokenStore });
        const file = new File(['test'], 'test.txt');

        await expect(client.debug.upload(file)).resolves.toEqual({
            path: '/tmp/uploaded-file',
            size: 4,
        });

        expect(send).toHaveBeenCalledWith(file);
        expect(headers.get('x-snowluma-token')).toBe(sessionToken);
        expect(headers.has('authorization')).toBe(false);
    });
});
