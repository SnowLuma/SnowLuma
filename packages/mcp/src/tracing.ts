import { randomBytes } from 'node:crypto';

export interface TraceContext {
    traceparent: string;
    tracestate?: string;
}

function parentFields(value: unknown): { traceId: string; flags: string } | undefined {
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

    // Participate using version 00, retaining only its defined sampled flag.
    return { traceId: match[2]!, flags: (Number.parseInt(match[4]!, 16) & 1) === 1 ? '01' : '00' };
}

function traceState(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 512 || /[^\x20-\x7e\t]/.test(value)) {
        return undefined;
    }

    const members = value.split(',');

    if (members.length > 32) {
        return undefined;
    }

    const keys = new Set<string>();
    const normalized: string[] = [];

    for (const raw of members) {
        const member = raw.replace(/^[ \t]+|[ \t]+$/g, '');

        if (!member) {
            continue;
        }

        const separator = member.indexOf('=');
        const key = member.slice(0, separator);
        const entry = member.slice(separator + 1);

        if (
            separator < 1 ||
            !/^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/.test(
                key,
            ) ||
            !/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/.test(entry) ||
            keys.has(key)
        ) {
            return undefined;
        }

        keys.add(key);
        normalized.push(member);
    }

    return normalized.join(',');
}

function identifier(bytes: number): string {
    let value: string;

    do {
        value = randomBytes(bytes).toString('hex');
    } while (/^0+$/.test(value));

    return value;
}

/** Trace metadata is advisory: invalid fields never reject a tool or enter its params. */
export function createCallTrace(meta?: Record<string, unknown>): TraceContext {
    const parent = parentFields(meta?.traceparent);

    if (meta?.traceparent !== undefined && !parent) {
        console.error('[snowluma-mcp] trace metadata ignored: invalid traceparent');
    }

    let state: string | undefined;

    if (meta?.tracestate !== undefined) {
        if (parent) {
            state = traceState(meta.tracestate);

            if (state === undefined) {
                console.error('[snowluma-mcp] trace metadata ignored: invalid tracestate');
            }
        } else {
            console.error(
                '[snowluma-mcp] trace metadata ignored: tracestate without valid traceparent',
            );
        }
    }

    return {
        traceparent: `00-${parent?.traceId ?? identifier(16)}-${identifier(8)}-${parent?.flags ?? '00'}`,
        ...(state ? { tracestate: state } : {}),
    };
}
