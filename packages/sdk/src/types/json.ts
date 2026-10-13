export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface JsonObject {
    [key: string]: JsonValue | undefined;
}

export type JsonArray = JsonValue[];

export interface ApiResponse<TData = JsonValue> {
    status: 'ok' | 'failed';
    retcode: number;
    data: TData;
    echo?: JsonValue;
    wording?: string;
}

export interface OneBotRequest<TParams extends JsonObject = JsonObject> {
    action: string;
    params?: TParams;
    echo?: JsonValue;
}

export type WsRole = 'Api' | 'Event' | 'Universal';
export type MessageFormat = 'array' | 'string';

/** Per-request controls shared by HTTP and WebSocket clients. */
export interface RequestOptions {
    /** Echo value used to correlate OneBot request and response packets. */
    echo?: JsonValue;
    /** Override the client's default timeout for this request. Set to 0 to disable timeout. */
    timeoutMs?: number;
    /** Cancels the request before a SnowLuma response arrives. */
    signal?: AbortSignal;
}

/** Shared options accepted by concrete SnowLuma clients. */
export interface SnowLumaClientOptions {
    /** Access token configured in SnowLuma's OneBot settings. */
    accessToken?: string;
    /** Default timeout for API calls in milliseconds. Defaults to 30000. */
    requestTimeoutMs?: number;
}
