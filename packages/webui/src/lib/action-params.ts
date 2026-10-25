import type { DebugActionParam } from '@/types';

function coerceParam({ name, type }: DebugActionParam, raw: string): unknown {
    if (raw === '') {
        return undefined;
    }

    if (/int|uint|number|messageId/i.test(type)) {
        const n = Number(raw);
        return Number.isFinite(n) ? n : raw;
    }

    if (type === 'bool' || type === 'boolean') {
        return raw === 'true' || raw === '1';
    }

    if (type === 'object' || type === 'string | object[]') {
        let parsed: unknown;

        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new Error(`${name} 的 JSON 格式无效`);
        }

        const isObject = (value: unknown) =>
            typeof value === 'object' && value !== null && !Array.isArray(value);

        if (type === 'object' && !isObject(parsed)) {
            throw new Error(`${name} 必须是 JSON 对象`);
        }

        if (
            type === 'string | object[]' &&
            typeof parsed !== 'string' &&
            !(Array.isArray(parsed) && parsed.every(isObject))
        ) {
            throw new Error(`${name} 必须是 JSON 字符串或对象数组`);
        }

        return parsed;
    }

    if (type === 'message') {
        const t = raw.trim();

        if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
            try {
                return JSON.parse(t);
            } catch {
                /* fall through to literal */
            }
        }

        return raw;
    }

    return raw;
}

export function buildActionParams(
    params: DebugActionParam[],
    fields: Record<string, string>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    for (const param of params) {
        const value = coerceParam(param, fields[param.name] ?? '');

        if (value !== undefined) {
            out[param.name] = value;
        }
    }

    return out;
}
