import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHttpClient } from '../src/client';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }

    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function directory() {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-cancel-'));
    dirs.push(dir);
    return dir;
}

describe('ordinary HTTP cancellation', () => {
    it.each([false, true])(
        'aborts the actual HTTP request (headers received: %s)',
        async (sendHeaders) => {
            const started = Promise.withResolvers<void>();
            const disconnected = Promise.withResolvers<void>();
            let count = 0;
            const server = createServer((_request, response) => {
                count++;
                response.on('close', () => disconnected.resolve());

                if (sendHeaders) {
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.write('{"status":');
                }

                started.resolve();
            });
            servers.push(server);
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();

            if (!address || typeof address === 'string') {
                throw new Error('missing test server port');
            }

            const client = makeHttpClient({
                endpoint: `http://127.0.0.1:${address.port}`,
                streamDir: directory(),
                timeoutMs: 5000,
            });
            const controller = new AbortController();
            const outcome = client
                .call('get_status', {}, { signal: controller.signal })
                .catch((error) => error);
            await started.promise;
            controller.abort(new Error('caller cancelled'));
            expect(await outcome).toMatchObject({ kind: 'cancelled' });
            await disconnected.promise;
            expect(count).toBe(1);
        },
    );

    it('does not issue an HTTP request when already cancelled', async () => {
        const fetcher = vi.fn<typeof fetch>();
        const client = makeHttpClient({
            endpoint: 'http://unused.invalid',
            streamDir: directory(),
            fetch: fetcher,
        });
        await expect(
            client.call('get_status', {}, { signal: AbortSignal.abort() }),
        ).rejects.toMatchObject({ kind: 'cancelled' });
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('retains the ordinary timeout and exposes its cause', async () => {
        const fetcher: typeof fetch = vi.fn(
            async (_input, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                        once: true,
                    });
                }),
        );
        const client = makeHttpClient({
            endpoint: 'http://unused.invalid',
            streamDir: directory(),
            fetch: fetcher,
            timeoutMs: 20,
        });
        await expect(client.call('get_status', {})).rejects.toMatchObject({ kind: 'timeout' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('reports resolved limits and paths without endpoint credentials', () => {
        const dir = directory();
        const client = makeHttpClient({
            endpoint: 'https://user:secret@example.invalid/path?token=secret',
            accessToken: 'secret',
            streamDir: dir,
            uploadRoot: dir,
            maxStreamBytes: 123,
            timeoutMs: 456,
        });
        expect(client.info).toMatchObject({
            timeout_ms: 456,
            max_stream_bytes: 123,
            download_quota_bytes: 246,
            max_active_streams: 4,
            upload_enabled: true,
        });
        expect(client.info?.upload_root).toBe(client.info?.download_directory);
        expect(JSON.stringify(client.info)).not.toMatch(/secret|example\.invalid/);
    });
});
