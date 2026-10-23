import type { ImageSegment, RecordSegment, VideoSegment } from './messages.js';
import type { UploadFileSource, UploadFileStreamOptions } from './streaming.js';

/** A byte source with a filename, including files opened by @snowluma/sdk/node. */
export interface NamedMediaSource {
    readonly source: UploadFileSource;
    readonly filename: string;
}

/** Strings are deliberately excluded: existing string paths refer to the server. */
export type MediaSource = UploadFileSource | NamedMediaSource;

export interface SendImageOptions extends UploadFileStreamOptions {
    image?: Omit<ImageSegment['data'], 'file'>;
}

export interface SendRecordOptions extends UploadFileStreamOptions {
    record?: Omit<RecordSegment['data'], 'file'>;
}

export interface SendVideoOptions extends UploadFileStreamOptions {
    /** A thumbnail path, if supplied, still refers to the server. */
    video?: Omit<VideoSegment['data'], 'file'>;
}

export interface SendFileOptions extends UploadFileStreamOptions {
    /** Display name in QQ; defaults to the uploaded file's name. */
    name?: string;
}

export interface SendGroupFileOptions extends SendFileOptions {
    folder?: string;
    folderId?: string;
}
