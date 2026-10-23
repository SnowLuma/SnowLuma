import { describe, expect, it, vi } from 'vitest';
import {
    SnowLumaAbortError,
    SnowLumaApiError,
    SnowLumaHttpClient,
    SnowLumaParseError,
} from '../src/index.js';
import type { JsonObject } from '../src/index.js';

const wrap = (data: unknown) => ({ status: 'ok', retcode: 0, stream: 'stream-action', data });
const wire = (data: unknown) => JSON.stringify(wrap(data)) + '\r\n\r\n';
const info = {
    type: 'stream',
    data_type: 'file_info',
    file_name: 'test',
    file_size: 2,
    chunk_size: 2,
};
const chunk = {
    type: 'stream',
    data_type: 'file_chunk',
    index: 0,
    data: 'YWI=',
    size: 2,
    base64_size: 4,
    progress: 100,
};
const complete = {
    type: 'response',
    data_type: 'file_complete',
    file_name: 'test',
    total_chunks: 1,
    total_bytes: 2,
    message: 'done',
};

async function download(frames: unknown[], onInfo?: (value: unknown) => void) {
    const client = new SnowLumaHttpClient({
        fetch: async () => new Response(frames.map(wire).join('')),
    });
    const stream = client.downloadFileStream({ file: 'test' }, { onInfo });
    const chunks: Uint8Array[] = [];

    while (true) {
        const result = await stream.next();

        if (result.done) {
            return { chunks, complete: result.value };
        }

        chunks.push(result.value);
    }
}

describe('file download helper', () => {
    it('yields bytes, exposes metadata and returns verified completion', async () => {
        const onInfo = vi.fn();
        expect(await download([info, chunk, complete], onInfo)).toEqual({
            chunks: [new Uint8Array([97, 98])],
            complete,
        });
        expect(onInfo).toHaveBeenCalledExactlyOnceWith(info);
    });

    it('accepts an unknown initial size and verifies the final totals', async () => {
        expect(
            (await download([{ ...info, file_size: 0 }, chunk, complete])).complete.total_bytes,
        ).toBe(2);
    });

    it('supports empty files', async () => {
        expect(
            (
                await download([
                    { ...info, file_size: 0 },
                    { ...complete, total_chunks: 0, total_bytes: 0 },
                ])
            ).chunks,
        ).toEqual([]);
    });

    it.each([
        ['missing info', [chunk, complete]],
        ['duplicate info', [info, info, chunk, complete]],
        ['missing chunk', [info, complete]],
        ['out-of-order index', [info, { ...chunk, index: 1 }, complete]],
        ['invalid base64', [info, { ...chunk, data: '????' }, complete]],
        ['non-canonical base64', [info, { ...chunk, data: 'YWL=' }, complete]],
        ['wrong chunk size', [info, { ...chunk, size: 3 }, complete]],
        ['wrong base64 size', [info, { ...chunk, base64_size: 5 }, complete]],
        ['wrong final size', [info, chunk, { ...complete, total_bytes: 3 }]],
        ['wrong final count', [info, chunk, { ...complete, total_chunks: 2 }]],
        ['wrong info size', [{ ...info, file_size: 3 }, chunk, complete]],
        ['wrong final name', [info, chunk, { ...complete, file_name: 'other' }]],
        ['unexpected frame', [info, { type: 'stream', data_type: 'other' }, complete]],
    ])('rejects %s', async (_name, frames) => {
        await expect(download(frames as unknown[])).rejects.toBeInstanceOf(SnowLumaParseError);
    });
});

function uploader(transform?: (data: JsonObject, params: JsonObject) => JsonObject) {
    const calls: JsonObject[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const { params } = JSON.parse(String(init?.body)) as { params: JsonObject };
        calls.push(params);
        const first = calls[0];
        const result: JsonObject = params.is_complete
            ? {
                  type: 'response',
                  status: 'file_complete',
                  stream_id: first.stream_id,
                  received_chunks: first.total_chunks,
                  total_chunks: first.total_chunks,
                  file_size: first.file_size,
                  file_path: '/remote/file',
                  file_name: 'test',
                  sha256: 'a'.repeat(64),
              }
            : {
                  type: 'stream',
                  status: 'chunk_received',
                  stream_id: params.stream_id,
                  received_chunks: Number(params.chunk_index) + 1,
                  total_chunks: params.total_chunks,
              };
        return new Response(wire(transform ? transform(result, params) : result));
    });
    return { client: new SnowLumaHttpClient({ fetch }), calls, fetch };
}

describe('file upload helper', () => {
    it('cancels a stalled readable source before any request is sent', async () => {
        const { client, fetch } = uploader();
        const cancel = vi.fn();
        const source = new ReadableStream<Uint8Array>({ cancel });
        const controller = new AbortController();
        const upload = client.uploadFileStream(source, { fileSize: 1, signal: controller.signal });
        await vi.waitFor(() => expect(source.locked).toBe(true));
        controller.abort();
        await expect(upload).rejects.toBeInstanceOf(SnowLumaAbortError);
        expect(cancel).toHaveBeenCalledOnce();
        expect(source.locked).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('does not send later chunks or finalize after cancellation from a progress callback', async () => {
        const { client, calls } = uploader();
        const controller = new AbortController();
        await expect(
            client.uploadFileStream(new Uint8Array([1, 2]), {
                chunkSize: 1,
                signal: controller.signal,
                onProgress: () => controller.abort(),
            }),
        ).rejects.toBeInstanceOf(SnowLumaAbortError);
        expect(calls).toHaveLength(1);
    });

    it('re-chunks async input, awaits progress and separately finalizes after all ACKs', async () => {
        const { client, calls } = uploader();
        const progress = vi.fn();
        let readSecond = false;
        const source = (async function* () {
            yield new Uint8Array([1, 2, 3, 4]);
            expect(progress).toHaveBeenCalledTimes(2);
            readSecond = true;
            yield new Uint8Array([5]);
        })();
        const result = await client.uploadFileStream(source, {
            fileSize: 5,
            chunkSize: 2,
            filename: 'input',
            streamId: 'test',
            onProgress: progress,
        });
        expect(readSecond).toBe(true);
        expect(calls.map((params) => params.chunk_data)).toEqual([
            'AQI=',
            'AwQ=',
            'BQ==',
            undefined,
        ]);
        expect(calls[0]).toMatchObject({ total_chunks: 3, file_size: 5, filename: 'input' });
        expect(calls[3]).toEqual({ stream_id: 'test', is_complete: true });
        expect(progress).toHaveBeenLastCalledWith({
            streamId: 'test',
            uploadedChunks: 3,
            totalChunks: 3,
            uploadedBytes: 5,
            fileSize: 5,
        });
        expect(result.file_path).toBe('/remote/file');
    });

    it.each([new Uint8Array(), new Blob([]), new Blob(['ab'])])(
        'infers size for byte and Blob sources: %s',
        async (source) => {
            const { client, calls } = uploader();
            const result = await client.uploadFileStream(source);
            expect(result.file_size).toBe(source instanceof Blob ? source.size : source.length);
            expect(calls).toHaveLength(2);
            expect(calls[0].total_chunks).toBe(1);
        },
    );

    it.each([0, 4])(
        'does not finalize a streaming source with mismatched size %i',
        async (fileSize) => {
            const { client, calls } = uploader();
            let closed = false;
            const source = (async function* () {
                try {
                    yield new Uint8Array([1, 2]);
                } finally {
                    closed = true;
                }
            })();
            await expect(
                client.uploadFileStream(source, { fileSize, chunkSize: 1 }),
            ).rejects.toThrow('fileSize');
            expect(closed).toBe(true);
            expect(calls.some((call) => call.is_complete)).toBe(false);
        },
    );

    it('requires a declared size and validates options before making requests', async () => {
        const { client, fetch } = uploader();
        const source = (async function* () {
            yield new Uint8Array([1]);
        })();
        await expect(client.uploadFileStream(source)).rejects.toThrow('fileSize');
        await expect(client.uploadFileStream(new Uint8Array([1]), { fileSize: 2 })).rejects.toThrow(
            'fileSize',
        );
        await expect(
            client.uploadFileStream(new Uint8Array([1]), { chunkSize: 0 }),
        ).rejects.toThrow('chunkSize');
        await expect(
            client.uploadFileStream(new Uint8Array([1]), { streamId: '../bad' }),
        ).rejects.toThrow('streamId');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects incorrect ACKs and cancels a readable source on failure', async () => {
        const { client, calls } = uploader((data) => ({ ...data, received_chunks: 99 }));
        const cancel = vi.fn();
        const source = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(new Uint8Array([1, 2]));
            },
            cancel,
        });
        await expect(client.uploadFileStream(source, { fileSize: 2 })).rejects.toBeInstanceOf(
            SnowLumaParseError,
        );
        expect(calls).toHaveLength(1);
        expect(cancel).toHaveBeenCalledOnce();
        expect(source.locked).toBe(false);
    });

    it('stops after a failed chunk and preserves the server error', async () => {
        const fetch = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        status: 'failed',
                        retcode: 1500,
                        data: { type: 'error' },
                        wording: 'disk full',
                    }),
                ),
        );
        const client = new SnowLumaHttpClient({ fetch });
        await expect(
            client.uploadFileStream(new Uint8Array(10), { chunkSize: 2 }),
        ).rejects.toBeInstanceOf(SnowLumaApiError);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('rejects inconsistent final metadata', async () => {
        const { client } = uploader((data, params) =>
            params.is_complete ? { ...data, file_size: 99 } : data,
        );
        await expect(client.uploadFileStream(new Uint8Array([1]))).rejects.toThrow(
            'completion metadata',
        );
    });
});
