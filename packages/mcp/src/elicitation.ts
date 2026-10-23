import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    createRequestStateCodec,
    fromJsonSchema,
    inputRequired,
    inputResponse,
    type InputRequiredResult,
    type ServerContext,
    type ServerOptions,
    type Tool,
} from '@modelcontextprotocol/server';
import { asError, type StructuredResult } from './results.js';

const INPUT_KEY = 'missing_parameters';
const INPUT_NAMES = {
    query_action_with_input: 'query_action',
    invoke_action_with_input: 'invoke_action',
} as const;

export type InputCompletionTool = keyof typeof INPUT_NAMES;

export interface InputPreparation {
    action: string;
    params: Record<string, unknown>;
    inputSchema: Record<string, unknown>;
}

export interface InputCompletionCallbacks {
    capabilities: unknown;
    /** Runs the same permission and argument checks as the existing execution tools. */
    preflight: (args: Record<string, unknown>) => InputPreparation | StructuredResult;
    execute: (args: Record<string, unknown>) => Promise<StructuredResult>;
}

interface PendingInput {
    fingerprint: string;
    expiresAt: number;
}

interface InputState {
    challenge: string;
}

export interface InputCompletion {
    verifyRequestState: NonNullable<NonNullable<ServerOptions['requestState']>['verify']>;
    handle: (
        name: InputCompletionTool,
        args: Record<string, unknown>,
        context: ServerContext,
        callbacks: InputCompletionCallbacks,
    ) => Promise<StructuredResult | InputRequiredResult>;
    close: () => void;
}

export function isInputCompletionTool(name: string): name is InputCompletionTool {
    return Object.hasOwn(INPUT_NAMES, name);
}

export function inputCompletionBaseTool(
    name: InputCompletionTool,
): 'query_action' | 'invoke_action' {
    return INPUT_NAMES[name];
}

/** Derive visibility, schemas, annotations and result contracts from the existing tools. */
export function inputCompletionTools(baseTools: Tool[]): Tool[] {
    return baseTools.flatMap((tool) => {
        if (tool.name !== 'query_action' && tool.name !== 'invoke_action') {
            return [];
        }

        return [
            {
                ...tool,
                name: `${tool.name}_with_input`,
                description: `${tool.description} 缺少必填参数时向支持表单的客户端请求补充；补充完成前不执行动作，已有参数不会被覆盖。`,
            },
        ];
    });
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Bind every round to the exact tool and original arguments, irrespective of JSON
// object key ordering. Values never appear in the signed token or diagnostics.
function fingerprint(name: string, args: Record<string, unknown>): string {
    function ordered(value: unknown): unknown {
        if (Array.isArray(value)) {
            return value.map(ordered);
        }

        if (isObject(value)) {
            return Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map((key) => [key, ordered(value[key])]),
            );
        }

        return value;
    }

    return createHash('sha256')
        .update(JSON.stringify([name, ordered(args)]))
        .digest('hex');
}

function supportsForm(capabilities: unknown): boolean {
    const elicitation = isObject(capabilities) ? capabilities.elicitation : undefined;

    if (!isObject(elicitation)) {
        return false;
    }

    // The pre-form/url capability shape declared form support with an empty object.
    return (
        isObject(elicitation.form) ||
        (elicitation.form === undefined && elicitation.url === undefined)
    );
}

/**
 * One instance belongs to one configured runtime, shared by its server factory.
 * Pending prompts are deliberately transient: a restart invalidates unfinished
 * input, and never resumes or retries a side effect automatically.
 */
export function createInputCompletion(
    options: { ttlSeconds?: number; maxPending?: number } = {},
): InputCompletion {
    const ttlSeconds = options.ttlSeconds ?? 600;
    const maxPending = options.maxPending ?? 256;

    if (
        !Number.isInteger(ttlSeconds) ||
        ttlSeconds < 1 ||
        !Number.isInteger(maxPending) ||
        maxPending < 1
    ) {
        throw new RangeError('Input completion limits must be positive integers');
    }

    const codec = createRequestStateCodec<InputState>({
        key: randomBytes(32),
        ttlSeconds,
        // HTTP callers must supply validated authInfo. Stdio has one trusted peer.
        // The codec hides the binding behind an HMAC, including bearer credentials.
        bind: (context) =>
            JSON.stringify([
                context.mcpReq.method,
                context.http?.authInfo?.clientId ?? null,
                context.http?.authInfo?.token ?? null,
                context.sessionId ?? null,
            ]),
    });
    const pending = new Map<string, PendingInput>();
    let closed = false;

    return {
        verifyRequestState: async (token, context) => {
            if (closed) {
                throw new Error('closed');
            }

            return codec.verify(token, context);
        },
        close() {
            closed = true;
            pending.clear();
        },
        async handle(name, args, context, callbacks) {
            if (closed) {
                return asError('补充输入服务已关闭。', 'configuration');
            }

            context.mcpReq.signal.throwIfAborted();
            const prepared = callbacks.preflight(args);

            if ('structuredContent' in prepared) {
                return prepared;
            }

            const state = context.mcpReq.requestState<unknown>();
            const required = Array.isArray(prepared.inputSchema.required)
                ? prepared.inputSchema.required.filter(
                      (key): key is string => typeof key === 'string',
                  )
                : [];
            const missing = required.filter((key) => !Object.hasOwn(prepared.params, key));
            const original = fingerprint(name, args);

            for (const [id, entry] of pending) {
                if (entry.expiresAt <= Date.now()) {
                    pending.delete(id);
                }
            }

            if (state !== undefined) {
                if (!isObject(state) || typeof state.challenge !== 'string') {
                    return asError('补充输入状态无效。');
                }

                const entry = pending.get(state.challenge);

                if (!entry || entry.fingerprint !== original) {
                    return asError('补充输入已过期、已使用或原始调用已变更，请重新发起调用。');
                }

                // Claim synchronously before validation or execution can yield. A
                // replay/concurrent retry can never execute the same answer twice.
                pending.delete(state.challenge);
                const response = inputResponse(context.mcpReq.inputResponses, INPUT_KEY);

                if (response.kind === 'elicit' && response.action !== 'accept') {
                    return asError(
                        '用户拒绝或取消补充输入，动作未执行。',
                        'cancelled',
                        '按用户意愿停止；需要时重新发起调用。',
                    );
                }

                if (
                    response.kind !== 'elicit' ||
                    !isObject(response.content) ||
                    typeof response.content.params_json !== 'string' ||
                    Object.keys(response.content).some((key) => key !== 'params_json')
                ) {
                    return asError('补充输入必须包含 params_json 字符串，动作未执行。');
                }

                let additions: unknown;

                try {
                    additions = JSON.parse(response.content.params_json);
                } catch {
                    return asError('补充参数不是有效 JSON，动作未执行。');
                }

                if (
                    !isObject(additions) ||
                    Object.keys(additions).some((key) => !missing.includes(key))
                ) {
                    return asError(
                        '补充参数只能包含本次缺失的必填字段，不能覆盖已有参数或添加其他字段。',
                    );
                }

                const properties = isObject(prepared.inputSchema.properties)
                    ? prepared.inputSchema.properties
                    : {};
                const schema = fromJsonSchema<Record<string, unknown>>({
                    type: 'object',
                    properties: Object.fromEntries(
                        missing.map((key) => [key, properties[key] ?? {}]),
                    ),
                    required: missing,
                    additionalProperties: false,
                });
                const validated = await schema['~standard'].validate(additions);

                if (validated.issues) {
                    return asError(
                        '补充参数不符合动作目录中的字段类型或约束，动作未执行。',
                        'invalid_arguments',
                        '使用 get_action 查看参数要求后重新发起调用。',
                    );
                }

                context.mcpReq.signal.throwIfAborted();

                if (closed) {
                    return asError('补充输入服务已关闭，动作未执行。', 'configuration');
                }

                return callbacks.execute({
                    ...args,
                    params: { ...prepared.params, ...validated.value },
                });
            }

            if (context.mcpReq.inputResponses || context.mcpReq.droppedInputResponseKeys?.length) {
                return asError('补充输入缺少有效请求状态，动作未执行。');
            }

            if (!missing.length) {
                return callbacks.execute(args);
            }

            if (!supportsForm(callbacks.capabilities)) {
                return asError(
                    '当前客户端未声明表单补充输入能力；请直接提供必填参数。',
                    'configuration',
                    '使用 get_action 查看参数后调用原 query_action 或 invoke_action。',
                );
            }

            if (pending.size >= maxPending) {
                return asError(
                    '待补充输入的请求数量已达上限，请完成现有请求或等待过期。',
                    'execution',
                );
            }

            const challenge = randomUUID();
            pending.set(challenge, {
                fingerprint: original,
                expiresAt: Date.now() + ttlSeconds * 1000,
            });

            try {
                const requestState = await codec.mint({ challenge }, context);
                context.mcpReq.signal.throwIfAborted();

                if (closed) {
                    throw new Error('Input completion closed');
                }

                const properties = isObject(prepared.inputSchema.properties)
                    ? prepared.inputSchema.properties
                    : {};
                return inputRequired({
                    inputRequests: {
                        [INPUT_KEY]: inputRequired.elicit({
                            mode: 'form',
                            message: `请补充 ${prepared.action} 缺失的必填参数：${missing.join('、')}。仅填写这些字段的 JSON 对象，已有参数保持不变。字段要求：${JSON.stringify(Object.fromEntries(missing.map((key) => [key, properties[key] ?? {}])))}`,
                            requestedSchema: {
                                type: 'object',
                                properties: {
                                    params_json: { type: 'string', title: '缺失参数（JSON 对象）' },
                                },
                                required: ['params_json'],
                            },
                        }),
                    },
                    requestState,
                });
            } catch (error) {
                pending.delete(challenge);
                throw error;
            }
        },
    };
}
