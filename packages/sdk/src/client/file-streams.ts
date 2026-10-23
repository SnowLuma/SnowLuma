import { SnowLumaParseError } from '../errors.js';
import { raceWithAbort, throwIfAborted } from '../internal/abort.js';
import { readBytes } from '../internal/streaming.js';
import type {
    DownloadFileStreamComplete,
    DownloadFileStreamInfo,
    DownloadFileStreamOptions,
    DownloadFileStreamParams,
    UploadFileSource,
    UploadFileStreamComplete,
    UploadFileStreamOptions,
    UploadFileStreamParams,
    UploadFileStreamResult,
} from '../types/index.js';
import type { SnowLumaApiClient } from './api-client.js';

function encodeBase64(bytes: Uint8Array): string {
    const parts: string[] = [];

    for (let i = 0; i < bytes.length; i += 0x8000) {
        parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
    }

    return btoa(parts.join(''));
}

function decodeBase64(value: string): Uint8Array {
    try {
        const binary = atob(value);

        if (btoa(binary) !== value) {
            throw new Error('non-canonical base64');
        }

        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch (cause) {
        throw new SnowLumaParseError('Invalid base64 in download chunk', { cause });
    }
}

function isSize(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

async function* sourceBytes(
    source: UploadFileSource,
    signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
    throwIfAborted(signal);

    if (source instanceof Uint8Array) {
        yield source;
        return;
    }

    if (source instanceof Blob) {
        yield* readBytes(source.stream(), signal);
        return;
    }

    if ('getReader' in source) {
        yield* readBytes(source, signal);
        return;
    }

    const iterator = source[Symbol.asyncIterator]();
    let ended = false;

    try {
        while (true) {
            throwIfAborted(signal);
            const next = await raceWithAbort(iterator.next(), signal);

            if (next.done) {
                ended = true;
                return;
            }

            yield next.value;
        }
    } finally {
        if (!ended) {
            await iterator.return?.();
        }
    }
}

async function* uploadChunks(
    source: UploadFileSource,
    fileSize: number,
    chunkSize: number,
    signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
    let buffer = new Uint8Array(Math.min(chunkSize, fileSize));
    let used = 0;
    let received = 0;

    for await (const bytes of sourceBytes(source, signal)) {
        if (!(bytes instanceof Uint8Array)) {
            throw new TypeError('Upload source must yield Uint8Array chunks');
        }

        received += bytes.byteLength;

        if (received > fileSize) {
            throw new RangeError('Upload source is longer than fileSize');
        }

        for (let offset = 0; offset < bytes.length;) {
            const count = Math.min(buffer.length - used, bytes.length - offset);
            buffer.set(bytes.subarray(offset, offset + count), used);
            used += count;
            offset += count;

            if (used === buffer.length) {
                yield buffer;
                buffer = new Uint8Array(chunkSize);
                used = 0;
            }
        }
    }

    if (received !== fileSize) {
        throw new RangeError('Upload source is shorter than fileSize');
    }

    if (used > 0 || fileSize === 0) {
        yield buffer.subarray(0, used);
    }
}

async function uploadResponse(
    client: SnowLumaApiClient,
    params: UploadFileStreamParams,
    options: UploadFileStreamOptions,
): Promise<UploadFileStreamResult> {
    let result: UploadFileStreamResult | undefined;

    for await (const frame of client.stream('upload_file_stream', params, options)) {
        if (result !== undefined) {
            throw new SnowLumaParseError('Upload request returned multiple acknowledgements');
        }

        result = frame;
    }

    if (!result) {
        throw new SnowLumaParseError('Upload request returned no acknowledgement');
    }

    return result;
}

export async function uploadFileStream(
    client: SnowLumaApiClient,
    source: UploadFileSource,
    options: UploadFileStreamOptions = {},
): Promise<UploadFileStreamComplete> {
    throwIfAborted(options.signal);
    const knownSize =
        source instanceof Uint8Array
            ? source.byteLength
            : source instanceof Blob
              ? source.size
              : undefined;
    const fileSize = options.fileSize ?? knownSize;
    const chunkSize = options.chunkSize ?? 64 * 1024;
    const streamId = options.streamId ?? globalThis.crypto.randomUUID();

    if (!isSize(fileSize)) {
        throw new RangeError('fileSize must be a non-negative safe integer for streaming sources');
    }

    if (knownSize !== undefined && knownSize !== fileSize) {
        throw new RangeError('fileSize does not match the upload source');
    }

    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 1024 * 1024) {
        throw new RangeError('chunkSize must be an integer between 1 and 1048576');
    }

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(streamId)) {
        throw new TypeError('streamId must contain 1–128 letters, digits, underscores or hyphens');
    }

    const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSize));
    let uploadedChunks = 0;
    let uploadedBytes = 0;

    for await (const bytes of uploadChunks(source, fileSize, chunkSize, options.signal)) {
        throwIfAborted(options.signal);
        const response = await uploadResponse(
            client,
            {
                stream_id: streamId,
                total_chunks: totalChunks,
                file_size: fileSize,
                filename: options.filename,
                expected_sha256: options.expectedSha256,
                file_retention: options.fileRetention,
                chunk_index: uploadedChunks,
                chunk_data: encodeBase64(bytes),
            },
            options,
        );
        uploadedChunks++;
        uploadedBytes += bytes.byteLength;

        if (
            response.type !== 'stream' ||
            response.status !== 'chunk_received' ||
            response.stream_id !== streamId ||
            response.total_chunks !== totalChunks ||
            response.received_chunks !== uploadedChunks
        ) {
            throw new SnowLumaParseError('Upload acknowledgement does not match the sent chunk');
        }

        await options.onProgress?.({
            streamId,
            uploadedBytes,
            fileSize,
            uploadedChunks,
            totalChunks,
        });
    }

    throwIfAborted(options.signal);
    // A chunk request returns early in the server handler. Finalization must
    // be a separate request, after the source has ended and every ACK arrived.
    const result = await uploadResponse(
        client,
        { stream_id: streamId, is_complete: true },
        options,
    );

    if (
        result.type !== 'response' ||
        result.status !== 'file_complete' ||
        result.stream_id !== streamId ||
        result.received_chunks !== totalChunks ||
        result.total_chunks !== totalChunks ||
        result.file_size !== fileSize ||
        typeof result.file_path !== 'string' ||
        !result.file_path ||
        typeof result.file_name !== 'string' ||
        typeof result.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(result.sha256) ||
        (options.expectedSha256 !== undefined &&
            result.sha256.toLowerCase() !== options.expectedSha256.toLowerCase())
    ) {
        throw new SnowLumaParseError('Invalid upload completion metadata');
    }

    return result;
}

export async function* downloadFileStream(
    client: SnowLumaApiClient,
    params: DownloadFileStreamParams,
    options: DownloadFileStreamOptions = {},
): AsyncGenerator<Uint8Array, DownloadFileStreamComplete, void> {
    let info: DownloadFileStreamInfo | undefined;
    let chunks = 0;
    let bytes = 0;

    for await (const frame of client.stream(
        options.action ?? 'download_file_stream',
        params,
        options,
    )) {
        throwIfAborted(options.signal);

        if (frame.type === 'stream' && frame.data_type === 'file_info') {
            if (
                info ||
                typeof frame.file_name !== 'string' ||
                !isSize(frame.file_size) ||
                !isSize(frame.chunk_size) ||
                frame.chunk_size === 0
            ) {
                throw new SnowLumaParseError('Invalid or duplicate download file info');
            }

            info = frame;
            await options.onInfo?.(info);
        } else if (frame.type === 'stream' && frame.data_type === 'file_chunk') {
            if (
                !info ||
                frame.index !== chunks ||
                typeof frame.data !== 'string' ||
                frame.base64_size !== frame.data.length ||
                typeof frame.progress !== 'number' ||
                !Number.isFinite(frame.progress) ||
                frame.progress < 0 ||
                frame.progress > 100
            ) {
                throw new SnowLumaParseError('Invalid or out-of-order download chunk');
            }

            const data = decodeBase64(frame.data);
            bytes += data.byteLength;
            chunks++;

            if (frame.size !== data.byteLength || (info.file_size > 0 && bytes > info.file_size)) {
                throw new SnowLumaParseError('Download chunk size does not match its metadata');
            }

            yield data;
        } else if (frame.type === 'response' && frame.data_type === 'file_complete') {
            if (
                !info ||
                frame.file_name !== info.file_name ||
                frame.total_chunks !== chunks ||
                frame.total_bytes !== bytes ||
                (info.file_size > 0 && info.file_size !== bytes) ||
                typeof frame.message !== 'string'
            ) {
                throw new SnowLumaParseError('Download completion does not match received bytes');
            }

            return frame;
        } else {
            throw new SnowLumaParseError('Unexpected download frame');
        }
    }

    throw new SnowLumaParseError('Download ended before file completion');
}
