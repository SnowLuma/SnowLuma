export const WEBUI_SESSION_HEADER = 'X-SnowLuma-Token';

/** Leave Authorization available for HTTP authentication at the reverse proxy. */
export function webuiSessionHeaders(token: string | null, initial?: HeadersInit): Headers {
    const headers = new Headers(initial);

    if (token) {
        headers.set(WEBUI_SESSION_HEADER, token);
    }

    return headers;
}
