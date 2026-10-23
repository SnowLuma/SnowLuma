import { SnowLumaConnectionError, SnowLumaParseError } from '../errors.js';
import type {
    ApiResponse,
    JsonValue,
    SnowLumaStreamAction,
    StreamApiResponse,
    StreamRequestOptions,
} from '../types/index.js';
import { raceWithAbort, throwIfAborted } from './abort.js';
import { assertApiResponse, isJsonObject } from './json.js';

export function streamLimits(options?: StreamRequestOptions) {
    const maxBufferBytes = options?.maxBufferBytes ?? 32 * 1024 * 1024;
    const maxBufferedFrames = options?.maxBufferedFrames ?? 256;

    for (const [name, value] of Object.entries({ maxBufferBytes, maxBufferedFrames })) {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new RangeError(`${name} must be a positive safe integer`);
        }
    }

    return { maxBufferBytes, maxBufferedFrames };
}

export function parseStreamResponse(value: unknown): StreamApiResponse<JsonValue> {
    if (!isJsonObject(value) || !Number.isSafeInteger(value.retcode) || !('data' in value)) {
        throw new SnowLumaParseError('Invalid SnowLuma stream response envelope');
    }

    let response: ApiResponse;

    try {
        response = assertApiResponse(value);
    } catch (cause) {
        throw new SnowLumaParseError('Invalid SnowLuma stream response envelope', { cause });
    }

    if (response.status === 'ok' && response.retcode === 0) {
        if (
            value.stream !== 'stream-action' ||
            !isJsonObject(response.data) ||
            (response.data.type !== 'stream' && response.data.type !== 'response')
        ) {
            throw new SnowLumaParseError('Invalid SnowLuma stream frame or missing stream marker');
        }
    }

    return {
        ...response,
        stream: value.stream === 'stream-action' ? value.stream : undefined,
        message: typeof value.message === 'string' ? value.message : undefined,
    };
}

export function isStreamTerminal(action: SnowLumaStreamAction, response: ApiResponse): boolean {
    // Each upload request has exactly one ACK, even though its data.type is
    // "stream". Only downloads keep the same request open for multiple frames.
    return (
        action === 'upload_file_stream' ||
        response.status !== 'ok' ||
        response.retcode !== 0 ||
        (isJsonObject(response.data) && response.data.type === 'response')
    );
}

async function cancelReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    failure?: { error: unknown },
): Promise<void> {
    try {
        await reader.cancel();
    } catch (error) {
        // Retain the original failure if the source also rejects cancellation.
        if (failure) {
            throw new AggregateError([failure.error, error], 'Stream cleanup failed');
        }

        throw error;
    }
}

/** Cancel on early exit and always release the Web Stream's reader lock. */
export async function* readBytes(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
    const reader = body.getReader();
    let ended = false;
    let failure: { error: unknown } | undefined;

    try {
        while (true) {
            throwIfAborted(signal);
            const next = await raceWithAbort(reader.read(), signal);

            if (next.done) {
                ended = true;
                return;
            }

            yield next.value;
        }
    } catch (error) {
        failure = { error };
        throw error;
    } finally {
        try {
            if (!ended) {
                await cancelReader(reader, failure);
            }
        } finally {
            reader.releaseLock();
        }
    }
}

/** HTTP frames are JSON objects separated by CRLF CRLF, not SSE or NDJSON. */
export async function* readHttpFrames(
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
    signal: AbortSignal,
): AsyncGenerator<StreamApiResponse<JsonValue>> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const encoder = new TextEncoder();
    let buffer = '';
    let bufferedBytes = 0;
    let searchFrom = 0;

    const parse = (text: string) => {
        try {
            return parseStreamResponse(JSON.parse(text));
        } catch (cause) {
            if (cause instanceof SnowLumaParseError) {
                throw cause;
            }

            throw new SnowLumaParseError('Invalid JSON in SnowLuma HTTP stream', { cause });
        }
    };

    const decode = (bytes?: Uint8Array) => {
        try {
            return decoder.decode(bytes, { stream: bytes !== undefined });
        } catch (cause) {
            throw new SnowLumaParseError('Invalid UTF-8 in SnowLuma HTTP stream', { cause });
        }
    };

    for await (const bytes of readBytes(body, signal)) {
        const text = decode(bytes);
        buffer += text;
        bufferedBytes += encoder.encode(text).byteLength;
        let end: number;

        while ((end = buffer.indexOf('\r\n\r\n', searchFrom)) !== -1) {
            const frame = buffer.slice(0, end);
            const size = encoder.encode(frame).byteLength;

            if (size > maxBytes) {
                throw new SnowLumaParseError('SnowLuma HTTP stream frame exceeds maxBufferBytes');
            }

            buffer = buffer.slice(end + 4);
            bufferedBytes -= size + 4;
            searchFrom = 0;

            if (frame.trim()) {
                yield parse(frame);
            }
        }

        if (bufferedBytes > maxBytes + 3) {
            throw new SnowLumaParseError('SnowLuma HTTP stream frame exceeds maxBufferBytes');
        }

        searchFrom = Math.max(0, buffer.length - 3);
    }

    buffer += decode();

    if (encoder.encode(buffer).byteLength > maxBytes) {
        throw new SnowLumaParseError('SnowLuma HTTP stream frame exceeds maxBufferBytes');
    }

    // Ordinary preflight errors are single JSON responses without a delimiter.
    if (buffer.trim()) {
        yield parse(buffer);
    }
}

/** WebSocket has no per-request backpressure; bound its queue and fail on overflow. */
export class StreamQueue<T> {
    private readonly items: { value: T; size: number }[] = [];
    private bytes = 0;
    private ended = false;
    private error?: Error;
    private waiting?: {
        resolve: (result: IteratorResult<T>) => void;
        reject: (error: Error) => void;
    };

    constructor(private readonly limits: ReturnType<typeof streamLimits>) {}

    push(value: T, size: number): void {
        if (this.ended) {
            return;
        }

        if (
            this.bytes + size > this.limits.maxBufferBytes ||
            this.items.length >= this.limits.maxBufferedFrames
        ) {
            throw new SnowLumaConnectionError('SnowLuma WebSocket stream buffer limit exceeded');
        }

        if (this.waiting) {
            this.waiting.resolve({ value, done: false });
            this.waiting = undefined;
        } else {
            this.items.push({ value, size });
            this.bytes += size;
        }
    }

    finish(): void {
        this.ended = true;
        this.waiting?.resolve({ value: undefined, done: true });
        this.waiting = undefined;
    }

    fail(error: Error): void {
        this.error = error;
        this.items.length = 0;
        this.bytes = 0;
        this.waiting?.reject(error);
        this.waiting = undefined;
        this.ended = true;
    }

    next(): Promise<IteratorResult<T>> {
        if (this.error) {
            return Promise.reject(this.error);
        }

        const item = this.items.shift();

        if (item) {
            this.bytes -= item.size;
            return Promise.resolve({ value: item.value, done: false });
        }

        if (this.ended) {
            return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise((resolve, reject) => {
            this.waiting = { resolve, reject };
        });
    }
}
