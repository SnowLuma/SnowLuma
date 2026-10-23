import type { ApiResponse, RequestOptions } from './json.js';
import type { DownloadFileStreamInfo } from './results.js';

export type DownloadStreamAction =
    'download_file_stream' | 'download_file_image_stream' | 'download_file_record_stream';

export type SnowLumaStreamAction =
    DownloadStreamAction | 'upload_file_stream' | 'test_download_stream';

/** Authentication/validation failures can arrive without the stream marker. */
export interface StreamApiResponse<TData> extends ApiResponse<TData> {
    stream?: 'stream-action';
    message?: string;
}

export interface StreamRequestOptions extends RequestOptions {
    /** Maximum HTTP frame or queued WebSocket payload bytes. Default: 32 MiB. */
    maxBufferBytes?: number;
    /** Maximum queued WebSocket frames. Default: 256. */
    maxBufferedFrames?: number;
}

export type UploadFileSource =
    Uint8Array | Blob | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface UploadProgress {
    streamId: string;
    uploadedBytes: number;
    fileSize: number;
    uploadedChunks: number;
    totalChunks: number;
}

export interface UploadFileStreamOptions extends RequestOptions {
    /** Required for streams/async iterables; inferred for Uint8Array and Blob. */
    fileSize?: number;
    /** Decoded bytes per chunk, 1–1048576. Default: 64 KiB. */
    chunkSize?: number;
    /** Must identify a fresh upload. Generated automatically when omitted. */
    streamId?: string;
    filename?: string;
    expectedSha256?: string;
    /** Server-side retention in milliseconds; zero disables expiry. */
    fileRetention?: number;
    /** Called after each acknowledged chunk; awaited before reading more input. */
    onProgress?: (progress: UploadProgress) => void | Promise<void>;
}

export interface DownloadFileStreamOptions extends StreamRequestOptions {
    action?: DownloadStreamAction;
    /** Called once before yielding file bytes. */
    onInfo?: (info: DownloadFileStreamInfo) => void | Promise<void>;
}
