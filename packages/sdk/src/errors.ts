import type { ApiResponse, UploadFileStreamComplete } from './types/index.js';

/** Base error for every exception intentionally thrown by the SnowLuma SDK. */
export class SnowLumaError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'SnowLumaError';
    }
}

/** A one-step media operation failed. The original error is preserved as cause. */
export class SnowLumaMediaSendError extends SnowLumaError {
    readonly stage: 'upload' | 'send';
    /** Present after a completed upload, even when sending fails or is cancelled. */
    readonly upload?: UploadFileStreamComplete;

    constructor(stage: 'upload' | 'send', cause: unknown, upload?: UploadFileStreamComplete) {
        super(`Media ${stage} failed${cause instanceof Error ? `: ${cause.message}` : ''}`, {
            cause,
        });
        this.name = 'SnowLumaMediaSendError';
        this.stage = stage;
        this.upload = upload;
    }
}

/** Transport-layer failures before a valid OneBot API response is available. */
export class SnowLumaTransportError extends SnowLumaError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'SnowLumaTransportError';
    }
}

/** The request was cancelled by the caller's AbortSignal. */
export class SnowLumaAbortError extends SnowLumaTransportError {
    constructor(message = 'SnowLuma request aborted', options?: ErrorOptions) {
        super(message, options);
        this.name = 'SnowLumaAbortError';
    }
}

/** The request exceeded the configured timeout. */
export class SnowLumaTimeoutError extends SnowLumaTransportError {
    readonly timeoutMs: number;

    constructor(message: string, timeoutMs: number, options?: ErrorOptions) {
        super(message, options);
        this.name = 'SnowLumaTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

/** The SDK could not establish or keep a connection to SnowLuma. */
export class SnowLumaConnectionError extends SnowLumaTransportError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'SnowLumaConnectionError';
    }
}

/** SnowLuma returned a payload that could not be parsed as the expected protocol shape. */
export class SnowLumaParseError extends SnowLumaTransportError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'SnowLumaParseError';
    }
}

/** A OneBot API response with status failed or a non-zero retcode. */
export class SnowLumaApiError<TData = unknown> extends SnowLumaError {
    readonly response: ApiResponse<TData>;
    readonly retcode: number;
    readonly wording?: string;

    constructor(response: ApiResponse<TData>) {
        super(response.wording || `SnowLuma API failed with retcode ${response.retcode}`);
        this.name = 'SnowLumaApiError';
        this.response = response;
        this.retcode = response.retcode;
        this.wording = response.wording;
    }
}

/** Authentication or authorization failure returned by SnowLuma. */
export class SnowLumaAuthError<TData = unknown> extends SnowLumaApiError<TData> {
    constructor(response: ApiResponse<TData>) {
        super(response);
        this.name = 'SnowLumaAuthError';
    }
}

export function createSnowLumaApiError<TData>(
    response: ApiResponse<TData>,
): SnowLumaApiError<TData> {
    return isAuthFailure(response)
        ? new SnowLumaAuthError(response)
        : new SnowLumaApiError(response);
}

function isAuthFailure(response: ApiResponse<unknown>): boolean {
    return response.retcode === 1401 || response.retcode === 401 || response.retcode === 403;
}
