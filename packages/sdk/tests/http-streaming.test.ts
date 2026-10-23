import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SnowLumaAbortError,
    SnowLumaApiError,
    SnowLumaAuthError,
    SnowLumaHttpClient,
    SnowLumaParseError,
    SnowLumaTimeoutError,
} from '../src/index.js';

const data = { type: 'stream', data_type: 'data_chunk', data: '中文🙂' };
const complete = { type: 'response', data_type: 'data_complete', data: 'done' };
const frame = (payload: unknown) => ({
    status: 'ok',
    retcode: 0,
    stream: 'stream-action',
    data: payload,
    echo: 'stream',
});
const wire = (payload: unknown) => JSON.stringify(payload) + '\r\n\r\n';

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
    const results: T[] = [];

    for await (const result of stream) {
        results.push(result);
    }

    return results;
}

function clientFor(body: BodyInit | null) {
    return new SnowLumaHttpClient({ fetch: async () => new Response(body) });
}

afterEach(() => vi.useRealTimers());

describe('HTTP streaming', () => {
    it('does not send an already-aborted request', async () => {
        const fetch = vi.fn();
        const client = new SnowLumaHttpClient({ fetch });
        await expect(
            client.stream('test_download_stream', {}, { signal: AbortSignal.abort() }).next(),
        ).rejects.toBeInstanceOf(SnowLumaAbortError);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('honors cancellation between frames buffered in the same HTTP read', async () => {
        const controller = new AbortController();
        const client = clientFor(wire(frame(data)) + wire(frame(complete)));
        const stream = client.stream('test_download_stream', {}, { signal: controller.signal });
        await stream.next();
        controller.abort();
        await expect(stream.next()).rejects.toBeInstanceOf(SnowLumaAbortError);
    });

    it.each(['one byte', 'one read'] as const)(
        'decodes split UTF-8 and delimiters: %s',
        async (mode) => {
            const bytes = new TextEncoder().encode(
                wire(frame(data)) + wire(frame(data)) + wire(frame(complete)),
            );
            let offset = 0;
            const body = new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (offset === bytes.length) {
                        controller.close();
                        return;
                    }

                    const end = mode === 'one byte' ? offset + 1 : bytes.length;
                    controller.enqueue(bytes.subarray(offset, end));
                    offset = end;
                },
            });
            const fetch = vi.fn(async () => new Response(body));
            const client = new SnowLumaHttpClient({ fetch, accessToken: 'test-token' });
            const results = await collect(
                client.requestStream('test_download_stream', {}, { echo: 'stream' }),
            );
            expect(results.map((result) => result.data)).toEqual([data, data, complete]);
            expect(
                results.every(
                    (result) => result.stream === 'stream-action' && result.echo === 'stream',
                ),
            ).toBe(true);
            expect(fetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
                    body: JSON.stringify({
                        action: 'test_download_stream',
                        params: {},
                        echo: 'stream',
                    }),
                }),
            );
            expect(body.locked).toBe(false);
        },
    );

    it('delivers a frame before EOF and cancels the reader when iteration stops', async () => {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(wire(frame(data))));
            },
            cancel,
        });
        const stream = clientFor(body).stream('test_download_stream', {});
        expect(await stream.next()).toMatchObject({ value: data, done: false });
        await stream.return();
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
    });

    it.each([
        ['', 'terminal'],
        [wire(frame(data)), 'terminal'],
        [wire({ status: 'ok', retcode: 0, data }), 'marker'],
        [wire({ status: 'ok', data }), 'envelope'],
        [wire(frame({ type: 'error' })), 'frame'],
        ['{bad json}\r\n\r\n', 'JSON'],
    ])('rejects incomplete or invalid responses: %s', async (body, message) => {
        await expect(collect(clientFor(body).stream('test_download_stream', {}))).rejects.toThrow(
            message,
        );
    });

    it('rejects malformed UTF-8', async () => {
        await expect(
            collect(clientFor(new Uint8Array([0xff])).stream('test_download_stream', {})),
        ).rejects.toBeInstanceOf(SnowLumaParseError);
    });

    it('bounds individual frames while allowing multiple frames in one large read', async () => {
        const text = wire(frame(data)).repeat(10) + wire(frame(complete));
        await expect(
            collect(clientFor(text).stream('test_download_stream', {}, { maxBufferBytes: 200 })),
        ).resolves.toHaveLength(11);
        await expect(
            collect(clientFor(text).stream('test_download_stream', {}, { maxBufferBytes: 10 })),
        ).rejects.toThrow('maxBufferBytes');
        await expect(
            collect(
                clientFor('x'.repeat(500)).stream(
                    'test_download_stream',
                    {},
                    { maxBufferBytes: 10 },
                ),
            ),
        ).rejects.toThrow('maxBufferBytes');
    });

    it('returns raw failures and throws typed API errors from stream()', async () => {
        const failure = { status: 'failed', retcode: 1401, data: null, wording: 'denied' };
        expect(
            await collect(
                clientFor(JSON.stringify(failure)).requestStream('test_download_stream', {}),
            ),
        ).toMatchObject([failure]);
        await expect(
            collect(clientFor(JSON.stringify(failure)).stream('test_download_stream', {})),
        ).rejects.toBeInstanceOf(SnowLumaAuthError);
        const stream = clientFor(wire(frame(data)) + wire({ ...failure, retcode: 1500 })).stream(
            'test_download_stream',
            {},
        );
        expect((await stream.next()).value).toEqual(data);
        await expect(stream.next()).rejects.toBeInstanceOf(SnowLumaApiError);
    });

    it.each(['abort', 'timeout'] as const)('releases a pending body read on %s', async (reason) => {
        vi.useFakeTimers();
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel });
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const stream = clientFor(body).stream(
            'test_download_stream',
            {},
            { signal: controller.signal, timeoutMs: 100 },
        );
        const next = expect(stream.next()).rejects.toBeInstanceOf(
            reason === 'abort' ? SnowLumaAbortError : SnowLumaTimeoutError,
        );
        await vi.advanceTimersByTimeAsync(0);

        if (reason === 'abort') {
            controller.abort();
        } else {
            await vi.advanceTimersByTimeAsync(100);
        }

        await next;
        expect(cancel).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalled();
        expect(body.locked).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('ends an upload ACK without waiting for a response-type frame or HTTP EOF', async () => {
        const ack = {
            type: 'stream',
            status: 'chunk_received',
            stream_id: 'id',
            received_chunks: 1,
            total_chunks: 2,
        };
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(wire(frame(ack))));
            },
            cancel,
        });
        expect(
            await collect(clientFor(body).stream('upload_file_stream', { stream_id: 'id' })),
        ).toEqual([ack]);
        expect(cancel).toHaveBeenCalledOnce();
    });
});
