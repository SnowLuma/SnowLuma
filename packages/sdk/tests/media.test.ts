import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SnowLumaAbortError,
    SnowLumaApiError,
    SnowLumaHttpClient,
    SnowLumaMediaSendError,
    SnowLumaTimeoutError,
    type JsonObject,
} from '../src/index.js';
import { localFile } from '../src/node/index.js';

function server(
    options: {
        failUpload?: boolean;
        failSend?: boolean;
        sendResponse?: (init?: RequestInit) => Promise<Response>;
    } = {},
) {
    const calls: Array<{ action: string; params: JsonObject }> = [];
    let first: JsonObject;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const { action, params } = JSON.parse(String(init?.body)) as {
            action: string;
            params: JsonObject;
        };
        calls.push({ action, params });

        if (action !== 'upload_file_stream') {
            if (options.sendResponse) {
                return options.sendResponse(init);
            }

            return Response.json(
                options.failSend
                    ? { status: 'failed', retcode: 123, data: null, wording: 'send rejected' }
                    : {
                          status: 'ok',
                          retcode: 0,
                          data: action.startsWith('upload_')
                              ? { file_id: 'file-id' }
                              : { message_id: -42 },
                      },
            );
        }

        if (params.chunk_index === 0) {
            first = params;
        }

        if (options.failUpload) {
            return new Response(
                JSON.stringify({ status: 'failed', retcode: 321, data: null }) + '\r\n\r\n',
            );
        }

        const data = params.is_complete
            ? {
                  type: 'response',
                  status: 'file_complete',
                  stream_id: first.stream_id,
                  received_chunks: first.total_chunks,
                  total_chunks: first.total_chunks,
                  file_size: first.file_size,
                  file_path: '/server/staged.bin',
                  file_name: first.filename ?? 'generated.bin',
                  sha256: 'a'.repeat(64),
              }
            : {
                  type: 'stream',
                  status: 'chunk_received',
                  stream_id: params.stream_id,
                  received_chunks: Number(params.chunk_index) + 1,
                  total_chunks: params.total_chunks,
              };

        return new Response(
            JSON.stringify({ status: 'ok', retcode: 0, stream: 'stream-action', data }) +
                '\r\n\r\n',
        );
    });
    return { client: new SnowLumaHttpClient({ fetch }), calls, fetch };
}

describe('one-step media sends', () => {
    it.each([
        ['sendGroupImage', 'send_group_msg', 'group_id', 'image'],
        ['sendPrivateImage', 'send_private_msg', 'user_id', 'image'],
        ['sendGroupRecord', 'send_group_msg', 'group_id', 'record'],
        ['sendPrivateRecord', 'send_private_msg', 'user_id', 'record'],
        ['sendGroupVideo', 'send_group_msg', 'group_id', 'video'],
        ['sendPrivateVideo', 'send_private_msg', 'user_id', 'video'],
    ] as const)(
        '%s sends only after every chunk and final ACK',
        async (method, action, id, type) => {
            const { client, calls } = server();
            const progress = vi.fn();
            await expect(
                client[method](123, new Uint8Array([1, 2, 3]), {
                    chunkSize: 2,
                    onProgress: progress,
                }),
            ).resolves.toEqual({ message_id: -42 });
            expect(calls.map((call) => call.action)).toEqual([
                'upload_file_stream',
                'upload_file_stream',
                'upload_file_stream',
                action,
            ]);
            expect(calls.slice(0, 2).map((call) => call.params.chunk_data)).toEqual([
                'AQI=',
                'Aw==',
            ]);
            expect(calls[2].params.is_complete).toBe(true);
            expect(calls[3].params).toEqual({
                [id]: 123,
                message: [{ type, data: { file: '/server/staged.bin' } }],
            });
            expect(progress).toHaveBeenLastCalledWith(
                expect.objectContaining({ uploadedBytes: 3 }),
            );
        },
    );

    it('preserves media attributes and does not mutate options', async () => {
        const { client, calls } = server();
        const image = Object.freeze({ subType: 1, summary: 'picture' });
        await client.sendGroupImage(123, new Blob(['bytes']), { image });
        expect(calls.at(-1)?.params.message).toEqual([
            { type: 'image', data: { file: '/server/staged.bin', subType: 1, summary: 'picture' } },
        ]);
        await client.sendPrivateVideo(456, new Uint8Array([1]), {
            video: { thumb: '/server/thumb' },
        });
        expect(calls.at(-1)?.params.message).toEqual([
            { type: 'video', data: { file: '/server/staged.bin', thumb: '/server/thumb' } },
        ]);
    });

    it('keeps the uploaded file authoritative when callers pass wider attribute objects', async () => {
        const { client, calls } = server();
        // Structurally typed options may include extra fields from an existing segment.
        const image = { file: '/wrong/image', summary: 'picture' };
        const record = { file: '/wrong/record', url: 'https://example.test/voice' };
        const video = { file: '/wrong/video', thumb: '/server/thumb' };
        const source = new Uint8Array([1]);
        await client.sendGroupImage(123, source, { image });
        await client.sendPrivateImage(123, source, { image });
        await client.sendGroupRecord(123, source, { record });
        await client.sendPrivateRecord(123, source, { record });
        await client.sendGroupVideo(123, source, { video });
        await client.sendPrivateVideo(123, source, { video });
        const sends = calls.filter((call) => call.action.startsWith('send_'));
        expect(sends).toHaveLength(6);

        for (const send of sends) {
            expect(send.params.message).toEqual([
                expect.objectContaining({
                    data: expect.objectContaining({ file: '/server/staged.bin' }),
                }),
            ]);
        }

        expect(image.file).toBe('/wrong/image');
    });

    it('preserves File names and uses the existing file publishing actions exactly once', async () => {
        const { client, calls } = server();
        await expect(
            client.sendGroupFile(123, new File(['bytes'], '报告.txt'), {
                folderId: '/folder',
            }),
        ).resolves.toEqual({ file_id: 'file-id' });
        expect(calls[0].params.filename).toBe('报告.txt');
        expect(calls.at(-1)).toEqual({
            action: 'upload_group_file',
            params: {
                group_id: 123,
                file: '/server/staged.bin',
                name: '报告.txt',
                folder_id: '/folder',
                upload_file: true,
            },
        });
        await client.sendPrivateFile(
            456,
            { source: new Uint8Array([1]), filename: 'original.txt' },
            {
                filename: 'staged.txt',
                name: '发送.txt',
            },
        );
        expect(calls[3].params.filename).toBe('staged.txt');
        expect(calls.at(-1)).toEqual({
            action: 'upload_private_file',
            params: {
                user_id: 456,
                file: '/server/staged.bin',
                name: '发送.txt',
                upload_file: true,
            },
        });
    });

    it('keeps async sources incremental and accepts declared sizes', async () => {
        const { client, calls } = server();
        const source = (async function* () {
            yield new Uint8Array([1]);
            expect(calls).toHaveLength(1);
            yield new Uint8Array([2]);
        })();
        await client.sendGroupImage(123, source, { fileSize: 2, chunkSize: 1 });
        expect(calls).toHaveLength(4);
    });

    it('reports upload failure with its cause and never dispatches the message', async () => {
        const { client, calls } = server({ failUpload: true });
        await expect(client.sendGroupImage(123, new Uint8Array([1]))).rejects.toMatchObject({
            name: 'SnowLumaMediaSendError',
            stage: 'upload',
            upload: undefined,
            cause: expect.any(SnowLumaApiError),
        });
        expect(calls).toHaveLength(1);
    });

    it('retains the completed upload and original send error without retrying', async () => {
        const { client, calls } = server({ failSend: true });
        await expect(client.sendGroupImage(123, new Uint8Array([1]))).rejects.toMatchObject({
            stage: 'send',
            upload: { file_path: '/server/staged.bin' },
            cause: expect.objectContaining({ retcode: 123 }),
        });
        expect(calls).toHaveLength(3);
    });

    it('prevents dispatch when cancellation occurs between upload and send', async () => {
        const controller = new AbortController();
        const { client, calls } = server();
        const upload = client.uploadFileStream.bind(client);
        vi.spyOn(client, 'uploadFileStream').mockImplementation(async (...args) => {
            const result = await upload(...args);
            controller.abort('stop');
            return result;
        });
        await expect(
            client.sendGroupImage(123, new Uint8Array([1]), {
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ stage: 'send', cause: expect.any(SnowLumaAbortError) });
        expect(calls.every((call) => call.action === 'upload_file_stream')).toBe(true);
    });

    it('passes cancellation to the upload and stops before any later stage', async () => {
        const controller = new AbortController();
        const { client, calls } = server();
        await expect(
            client.sendPrivateFile(123, new Uint8Array([1, 2]), {
                chunkSize: 1,
                signal: controller.signal,
                onProgress: () => controller.abort(),
            }),
        ).rejects.toMatchObject({ stage: 'upload', cause: expect.any(SnowLumaAbortError) });
        expect(calls).toHaveLength(1);
    });

    it('passes request controls to both stages', async () => {
        const { client } = server();
        const upload = vi.spyOn(client, 'uploadFileStream');
        const send = vi.spyOn(client, 'sendGroupMessage');
        const controls = { signal: new AbortController().signal, timeoutMs: 1234, echo: 'media' };
        await client.sendGroupImage(123, new Uint8Array([1]), controls);
        expect(upload.mock.calls[0][1]).toMatchObject(controls);
        expect(send.mock.calls[0][2]).toEqual(controls);
    });

    it.each(['abort', 'timeout'] as const)(
        'retains upload metadata when an in-flight send ends by %s',
        async (mode) => {
            vi.useFakeTimers();

            try {
                const controller = new AbortController();
                const { client, calls } = server({
                    sendResponse: (init) =>
                        new Promise((_resolve, reject) => {
                            init?.signal?.addEventListener(
                                'abort',
                                () => reject(init.signal?.reason),
                                { once: true },
                            );
                        }),
                });
                const result = client.sendGroupImage(123, new Uint8Array([1]), {
                    signal: controller.signal,
                    timeoutMs: 1000,
                });
                const rejected = expect(result).rejects.toMatchObject({
                    stage: 'send',
                    upload: { file_path: '/server/staged.bin' },
                    cause:
                        mode === 'abort'
                            ? expect.any(SnowLumaAbortError)
                            : expect.any(SnowLumaTimeoutError),
                });
                await vi.waitFor(() => expect(calls.at(-1)?.action).toBe('send_group_msg'));

                if (mode === 'abort') {
                    controller.abort();
                } else {
                    await vi.advanceTimersByTimeAsync(1000);
                }

                await rejected;
                expect(calls).toHaveLength(3);
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it('never treats a string as a local path', async () => {
        const { client, fetch } = server();
        // @ts-expect-error A local path must be explicitly opened with localFile().
        await expect(client.sendGroupImage(123, './local.png')).rejects.toBeInstanceOf(
            SnowLumaMediaSendError,
        );
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('Node localFile source', () => {
    let directory: string | undefined;

    afterEach(async () => {
        if (directory) {
            await rm(directory, { recursive: true, force: true });
        }
    });

    async function fixture() {
        directory = await mkdtemp(join(tmpdir(), 'sdk-local-media-'));
        const path = join(directory, '图片.bin');
        await writeFile(path, new Uint8Array([7, 8, 9]));
        return path;
    }

    it('sends file-backed bytes from paths and file URLs without leaking the local path', async () => {
        const path = await fixture();

        for (const location of [path, pathToFileURL(path)]) {
            const source = await localFile(location);
            const { client, calls } = server();
            await client.sendPrivateImage(123, source);
            expect(calls[0].params).toMatchObject({
                filename: '图片.bin',
                file_size: 3,
                chunk_data: 'BwgJ',
            });
            expect(JSON.stringify(calls)).not.toContain(directory);
        }
    });

    it('reports missing files and rejects directories before uploading', async () => {
        const path = await fixture();
        await expect(localFile(path + '.missing')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(localFile(directory!)).rejects.toThrow('regular file');
    });

    it('fails if the file changes after the source is created', async () => {
        const path = await fixture();
        const source = await localFile(path);
        await writeFile(path, 'modified file');
        const { client, fetch } = server();
        await expect(client.sendGroupFile(123, source)).rejects.toMatchObject({ stage: 'upload' });
        expect(fetch).not.toHaveBeenCalled();
    });
});
