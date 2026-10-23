import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
    SnowLumaApiError,
    SnowLumaHttpClient,
    SnowLumaWebSocketClient,
    type SnowLumaApiClient,
} from '../../sdk/src/index';
import type { ApiActionContext } from '../src/api-handler';
import { actions as uploadActions, __test as uploadTest } from '../src/actions/stream-file';
import { actions as downloadActions } from '../src/actions/stream-download';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import { okResponse, type HttpServerNetwork } from '../src/types';
import { createCompiledTestHandler, testAction } from './helpers/compiled-action-handler';

// Real server adapters, parsers and disk handlers, isolated by tests/setup.ts.
// No QQ session or protocol requests are involved.
describe('SDK streaming against OneBot', () => {
    let adapter: HttpServerAdapter | undefined;
    let ws: SnowLumaWebSocketClient | undefined;

    afterEach(async () => {
        ws?.close();
        ws = undefined;
        await adapter?.close();
        adapter = undefined;

        for (const key of uploadTest.uploads.keys()) {
            uploadTest.cleanupUpload(key, true);
        }
    });

    async function connect(transport: 'http' | 'ws'): Promise<SnowLumaApiClient> {
        const api = createCompiledTestHandler({} as ApiActionContext, [
            ...uploadActions,
            ...downloadActions,
            testAction('sdk_ping', () => okResponse({ pong: true })),
        ]);
        const config: HttpServerNetwork = {
            name: 'sdk-streaming',
            host: '127.0.0.1',
            port: 0,
            path: '/',
            enabled: true,
            enableWebSocket: true,
            accessToken: 'sdk-test',
            messageFormat: 'array',
            reportSelfMessage: false,
        };
        adapter = new HttpServerAdapter(config.name, config, {
            uin: '10001',
            api,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        });
        await adapter.open();
        const { port } = (adapter as unknown as { server: Server }).server.address() as AddressInfo;

        if (transport === 'http') {
            return new SnowLumaHttpClient({
                baseUrl: `http://127.0.0.1:${port}/`,
                accessToken: 'sdk-test',
            });
        }

        ws = new SnowLumaWebSocketClient({
            url: `ws://127.0.0.1:${port}/api`,
            accessToken: 'sdk-test',
        });
        await ws.connect();
        return ws;
    }

    it.each(['http', 'ws'] as const)(
        '%s uploads and downloads binary data incrementally',
        async (transport) => {
            const client = await connect(transport);
            const bytes = Uint8Array.from({ length: 210007 }, (_, index) => index % 256);
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            const result = await client.uploadFileStream(
                Readable.from([
                    bytes.subarray(0, 17),
                    bytes.subarray(17, 100009),
                    bytes.subarray(100009),
                ]),
                {
                    fileSize: bytes.length,
                    chunkSize: 16384,
                    filename: '二进制.bin',
                    expectedSha256: sha256,
                    fileRetention: 0,
                },
            );
            expect(result.sha256).toBe(sha256);
            expect(result.total_chunks).toBe(Math.ceil(bytes.length / 16384));
            expect(await readFile(result.file_path)).toEqual(Buffer.from(bytes));

            for (const action of [
                'download_file_stream',
                'download_file_image_stream',
                'download_file_record_stream',
            ] as const) {
                const stream = client.downloadFileStream(
                    { file: result.file_path, chunk_size: 8192 },
                    { action },
                );
                const output: Uint8Array[] = [];

                while (true) {
                    const next = await stream.next();

                    if (next.done) {
                        expect(next.value).toMatchObject({
                            total_bytes: bytes.length,
                            total_chunks: output.length,
                        });
                        break;
                    }

                    expect(next.value.byteLength).toBeLessThanOrEqual(8192);
                    output.push(next.value);
                }

                expect(output.length).toBeGreaterThan(1);
                expect(Buffer.concat(output)).toEqual(Buffer.from(bytes));
            }

            await expect(client.raw('sdk_ping')).resolves.toEqual({ pong: true });
        },
    );

    it.each(['http', 'ws'] as const)('%s handles empty files', async (transport) => {
        const client = await connect(transport);
        const result = await client.uploadFileStream(new Uint8Array(), { fileRetention: 0 });
        expect(result.file_size).toBe(0);
        const stream = client.downloadFileStream({ file: result.file_path });
        expect(await stream.next()).toMatchObject({
            done: true,
            value: { total_bytes: 0, total_chunks: 0 },
        });
    });

    it.each(['http', 'ws'] as const)(
        '%s preserves a server error after partial download output',
        async (transport) => {
            const client = await connect(transport);
            const received: unknown[] = [];

            const run = async () => {
                for await (const frame of client.stream('test_download_stream', { error: true })) {
                    received.push(frame);
                }
            };

            await expect(run()).rejects.toBeInstanceOf(SnowLumaApiError);
            expect(received).toHaveLength(10);
        },
    );

    it.each(['http', 'ws'] as const)(
        '%s propagates server hash validation failure',
        async (transport) => {
            const client = await connect(transport);
            await expect(
                client.uploadFileStream(new Uint8Array([1]), { expectedSha256: '0'.repeat(64) }),
            ).rejects.toThrow('sha256 mismatch');
        },
    );
});
