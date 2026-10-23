import { SnowLumaMediaSendError } from '../errors.js';
import { throwIfAborted } from '../internal/abort.js';
import type {
    MediaSource,
    UploadFileStreamComplete,
    UploadFileStreamOptions,
} from '../types/index.js';
import type { SnowLumaApiClient } from './api-client.js';

/** Upload and send are separate operations; never retry a possibly completed send. */
export async function sendUploadedMedia<TResult>(
    client: SnowLumaApiClient,
    input: MediaSource,
    options: UploadFileStreamOptions,
    send: (upload: UploadFileStreamComplete) => Promise<TResult>,
): Promise<TResult> {
    let upload: UploadFileStreamComplete;

    try {
        throwIfAborted(options.signal);

        if (typeof input !== 'object' || input === null) {
            throw new TypeError('Media source must contain bytes; use localFile() for local paths');
        }

        const source = 'source' in input ? input.source : input;
        const filename =
            'source' in input
                ? input.filename
                : source instanceof Blob && 'name' in source && typeof source.name === 'string'
                  ? source.name
                  : undefined;
        upload = await client.uploadFileStream(source, {
            ...options,
            filename: options.filename ?? filename,
        });
    } catch (cause) {
        throw new SnowLumaMediaSendError('upload', cause);
    }

    try {
        // Cancellation can arrive with the final upload ACK, before dispatching the send.
        throwIfAborted(options.signal);
        return await send(upload);
    } catch (cause) {
        throw new SnowLumaMediaSendError('send', cause, upload);
    }
}
