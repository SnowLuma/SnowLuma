import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import type { OneBotEnvelope } from './client.js';

export type FailureKind =
    | 'invalid_arguments'
    | 'not_found'
    | 'permission'
    | 'configuration'
    | 'business'
    | 'authentication'
    | 'cancelled'
    | 'timeout'
    | 'transport'
    | 'invalid_response'
    | 'execution';

export interface Diagnostics {
    outcome: 'success' | 'failed' | 'unknown';
    kind?: FailureKind;
    message?: string;
    next_step?: string;
}

export type StructuredResult = CallToolResult & {
    structuredContent: { result: unknown; diagnostics: Diagnostics };
};

export class ActionCallError extends Error {
    constructor(
        message: string,
        readonly kind: FailureKind,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'ActionCallError';
    }
}

export const RESULT_SCHEMA: Tool['outputSchema'] = {
    type: 'object',
    properties: {
        result: {},
        diagnostics: {
            type: 'object',
            properties: {
                outcome: { type: 'string', enum: ['success', 'failed', 'unknown'] },
                kind: { type: 'string' },
                message: { type: 'string' },
                next_step: { type: 'string' },
            },
            required: ['outcome'],
            additionalProperties: false,
        },
    },
    required: ['result', 'diagnostics'],
    additionalProperties: false,
};

// The text block is the original public contract; structured metadata is additive.
export function asText(
    data: unknown,
    diagnostics: Diagnostics = { outcome: 'success' },
): StructuredResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: { result: data, diagnostics: { ...diagnostics } },
    };
}

export function asError(
    message: string,
    kind: FailureKind = 'invalid_arguments',
    nextStep = '检查工具参数；使用 get_action 查看动作要求。',
    outcome: Diagnostics['outcome'] = 'failed',
): StructuredResult {
    return {
        content: [{ type: 'text', text: message }],
        isError: true,
        structuredContent: {
            result: null,
            diagnostics: { outcome, kind, message, next_step: nextStep },
        },
    };
}

export function envelopeDiagnostics(envelope: OneBotEnvelope): Diagnostics {
    if (envelope.status === 'ok' && envelope.retcode === 0) {
        return { outcome: 'success' };
    }

    if (envelope.status === 'async') {
        return { outcome: 'unknown', next_step: '请求已受理，尚未确认完成；不要重复执行写操作。' };
    }

    if (
        envelope.status === 'failed' ||
        (typeof envelope.retcode === 'number' && envelope.retcode !== 0)
    ) {
        return {
            outcome: 'failed',
            kind: 'business',
            message:
                (typeof envelope.wording === 'string' && envelope.wording) ||
                (typeof envelope.message === 'string' && envelope.message) ||
                `retcode=${envelope.retcode}`,
            next_step: '检查原始响应的 retcode、wording 和动作参数；不要盲目重试写操作。',
        };
    }

    return {
        outcome: 'unknown',
        kind: 'invalid_response',
        next_step: '响应未确认成功；检查服务端版本和日志。',
    };
}

export function executionError(
    action: string,
    error: unknown,
    signal?: AbortSignal,
): StructuredResult {
    const message = `调用失败 (${action}): ${error instanceof Error ? error.message : String(error)}`;
    let cause = error;
    const seen = new Set<unknown>();

    while (cause instanceof Error && !(cause instanceof ActionCallError) && !seen.has(cause)) {
        seen.add(cause);
        cause = cause.cause;
    }

    const kind = signal?.aborted
        ? 'cancelled'
        : cause instanceof ActionCallError
          ? cause.kind
          : 'execution';
    return asError(
        message,
        kind,
        '操作结果可能未知。检查连接、配置和服务端状态；取消或超时不代表撤销，确认结果后再决定是否重试。',
        'unknown',
    );
}
