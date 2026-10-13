import type { ApiResponse, JsonObject, JsonValue } from '../types/index';

export function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asJsonValue(value: unknown): JsonValue {
    if (value === null) {
        return null;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(asJsonValue);
    }

    if (isJsonObject(value)) {
        const out: JsonObject = {};

        for (const [key, item] of Object.entries(value)) {
            if (item === undefined) {
                continue;
            }

            out[key] = asJsonValue(item);
        }

        return out;
    }

    return String(value);
}

export function assertApiResponse(value: unknown): ApiResponse {
    if (!isJsonObject(value)) {
        throw new Error('response is not a JSON object');
    }

    const status = value.status === 'ok' ? 'ok' : value.status === 'failed' ? 'failed' : null;

    if (!status) {
        throw new Error('response status is missing or invalid');
    }

    const retcode =
        typeof value.retcode === 'number' && Number.isFinite(value.retcode)
            ? value.retcode
            : status === 'ok'
              ? 0
              : -1;

    return {
        status,
        retcode,
        data: asJsonValue(value.data ?? null),
        echo: value.echo === undefined ? undefined : asJsonValue(value.echo),
        wording: typeof value.wording === 'string' ? value.wording : undefined,
    };
}

export function createEcho(): string {
    const random = Math.random().toString(36).slice(2);
    return `snowluma-sdk:${Date.now().toString(36)}:${random}`;
}

export function echoKey(value: JsonValue | undefined): string {
    if (value === undefined) {
        return '';
    }

    return JSON.stringify(value);
}

export function appendAccessToken(urlValue: string, accessToken?: string): string {
    if (!accessToken) {
        return urlValue;
    }

    const url = new URL(urlValue);

    if (!url.searchParams.has('access_token')) {
        url.searchParams.set('access_token', accessToken);
    }

    return url.toString();
}
