/** Accept W3C traceparent without treating caller-supplied IDs as local request IDs. */
export function httpTraceparent(value: unknown): string | undefined {
    if (typeof value !== 'string' || /[^\x21-\x7e]/.test(value)) {
        return undefined;
    }

    const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(.*)$/.exec(value);

    if (
        !match ||
        match[1] === 'ff' ||
        /^0+$/.test(match[2]!) ||
        /^0+$/.test(match[3]!) ||
        (match[1] === '00' ? match[5] !== '' : match[5] !== '' && !match[5]!.startsWith('-'))
    ) {
        return undefined;
    }

    // Future-version fields are opaque and must not enter application logs.
    return value.slice(0, 55);
}
