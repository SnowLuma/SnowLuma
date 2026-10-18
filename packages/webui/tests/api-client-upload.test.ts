import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';

class FakeUpload {
    static instances: FakeUpload[] = [];
    status = 200;
    response: unknown = { status: 'ok', path: '/tmp/file', size: 3 };
    responseType = '';
    upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    sent = false;
    constructor() {
        FakeUpload.instances.push(this);
    }
    open() {}
    setRequestHeader() {}
    send() {
        this.sent = true;
    }
    abort() {
        if (this.sent) {
            this.onabort?.();
        }
    }
}

beforeEach(() => {
    FakeUpload.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeUpload);
});
afterEach(() => vi.unstubAllGlobals());

describe('debug upload lifecycle', () => {
    it('does not clear a new session when an old upload returns 401', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ token: 'new-token' })));
        const save = vi.fn();
        const onUnauthorized = vi.fn();
        const client = createApiClient({
            tokenStore: { load: () => 'old-token', save },
            onUnauthorized,
        });
        const result = client.debug.upload(new File(['abc'], 'a.txt'));
        const rejected = expect(result).rejects.toMatchObject({ status: 401 });
        await client.login('password');
        const upload = FakeUpload.instances[0]!;
        upload.status = 401;
        upload.onload?.();
        await rejected;
        expect(save.mock.calls).toEqual([['new-token']]);
        expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it('settles an already cancelled upload without sending a request', async () => {
        const client = createApiClient({ tokenStore: { load: () => 'token', save: vi.fn() } });
        const signal = AbortSignal.abort();
        const settled = vi.fn();
        void client.debug.upload(new File(['abc'], 'a.txt'), { signal }).catch(settled);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toHaveBeenCalledWith(expect.objectContaining({ message: '上传已取消' }));
        expect(FakeUpload.instances.every((upload) => !upload.sent)).toBe(true);
    });

    it.each(['load', 'error', 'abort'] as const)(
        'releases abort and XHR handlers after %s',
        async (event) => {
            const client = createApiClient({ tokenStore: { load: () => 'token', save: vi.fn() } });
            const controller = new AbortController();
            const remove = vi.spyOn(controller.signal, 'removeEventListener');
            const result = client.debug.upload(new File(['abc'], 'a.txt'), {
                signal: controller.signal,
            });
            const settled = result.catch(() => undefined);
            const upload = FakeUpload.instances[0]!;
            upload[`on${event}`]?.();
            await settled;
            expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
            expect(upload.onload).toBeNull();
            expect(upload.onerror).toBeNull();
            expect(upload.onabort).toBeNull();
            expect(upload.upload.onprogress).toBeNull();
        },
    );
});
