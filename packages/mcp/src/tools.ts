// Tool surface for the MCP — kept free of any stdio / transport / env concerns
// so it is directly unit-testable. `server.ts` reads the environment, builds a
// client, and wires `computeTools` / `callTool` into the MCP request handlers.
//
// Two execution tools partition the action space by side-effect:
//   • query_action  — read-only actions only   (readOnlyHint)
//   • invoke_action — any known action          (destructiveHint, write mode)
// Visibility is gated by `mode`, and `callTool` RE-checks every permission
// (defense in depth: a client may call a tool that was never listed).

import type { Tool } from '@modelcontextprotocol/server';
import { ACTIONS, CATEGORIES } from './generated/catalog.js';
import type { CatalogAction } from './types.js';
import type { ActionClient } from './client.js';
import { MCP_UPLOAD_OWNED_FIELDS } from './client.js';
import { discover, FILTER_PROPERTIES } from './discovery.js';
import {
    asText,
    asError,
    envelopeDiagnostics,
    executionError,
    RESULT_SCHEMA,
    type Diagnostics,
    type StructuredResult,
} from './results.js';
import { VERSION } from './version.js';
import type { TransferProgress } from './client.js';
import type { TraceContext } from './tracing.js';

export type Mode = 'docs' | 'read' | 'write';

export function parseMode(raw: string | undefined): Mode | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const value = raw.trim().toLowerCase();

    if (value === 'docs' || value === 'read' || value === 'write') {
        return value;
    }

    throw new Error('SNOWLUMA_MCP_MODE must be one of: docs, read, write');
}

// name + every alias → action, so lookups accept aliases too.
const byName = new Map<string, CatalogAction>();

for (const a of ACTIONS) {
    for (const n of [a.name, ...a.aliases]) {
        byName.set(n, a);
    }
}

const DOCS_TOOLS: Tool[] = [
    {
        name: 'list_actions',
        description:
            '列出 OneBot action，支持分类、读写类型、流式类型筛选和可选分页。省略分页时返回全部匹配项。',
        inputSchema: {
            type: 'object',
            properties: {
                ...FILTER_PROPERTIES,
            },
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'get_action',
        description:
            '获取 action 文档、参数与返回数据 JSON Schema、约束和调用示例。示例中的标识和路径需替换；流式返回结构描述单帧数据。',
        inputSchema: {
            type: 'object',
            properties: { name: { type: 'string', description: 'action 名（接受别名）' } },
            required: ['name'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'search_actions',
        description:
            '按名称、摘要或别名搜索 action。默认保留子串匹配；match=keywords 启用多关键词和常用中英文同义词，支持筛选及分页。',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '关键字；keywords 模式可用空格分隔多个词' },
                match: {
                    type: 'string',
                    enum: ['substring', 'keywords'],
                    description: '默认 substring',
                },
                ...FILTER_PROPERTIES,
            },
            required: ['query'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'list_categories',
        description: '列出所有分类及其 action 数量。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
        name: 'get_runtime_info',
        description:
            '查看当前 MCP 模式、执行能力、文件限制和目录版本。默认不访问服务端；check_connection=true 仅在执行模式主动查询登录账号、状态和版本。静态目录不代表服务端支持全部动作。',
        inputSchema: {
            type: 'object',
            properties: {
                check_connection: {
                    type: 'boolean',
                    description: '主动进行三项只读查询，默认 false',
                },
            },
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
    },
];

const EXEC_INPUT_SCHEMA = {
    type: 'object' as const,
    properties: {
        action: {
            type: 'string',
            description: 'action 名（接受别名）。先用 get_action 查它的参数 inputSchema。',
        },
        params: { type: 'object', description: '该 action 的参数对象', additionalProperties: true },
        execution: {
            type: 'object',
            description: 'MCP 主机侧执行选项（不会发送为 OneBot params）。自动上传本地文件时使用。',
            properties: {
                input_file: {
                    type: 'string',
                    description:
                        'MCP 主机上的文件路径。仅用于 upload_file_stream，且必须位于 SNOWLUMA_MCP_UPLOAD_ROOT。',
                },
            },
            additionalProperties: false,
        },
    },
    required: ['action'],
    additionalProperties: false,
};

function queryTool(): Tool {
    return {
        name: 'query_action',
        description:
            '调用一个【只读】OneBot action（如 get_*/can_*）并返回完整响应。仅接受只读 action；写操作请用 invoke_action。',
        inputSchema: EXEC_INPUT_SCHEMA,
        annotations: { readOnlyHint: true, openWorldHint: true },
    };
}

function invokeTool(): Tool {
    return {
        name: 'invoke_action',
        description:
            '调用一个 OneBot action（可产生副作用）。Stream 下载会写入 MCP 主机受控目录并只返回文件元数据；upload_file_stream 可用 execution.input_file 自动分块上传。仅在写模式可用。',
        inputSchema: EXEC_INPUT_SCHEMA,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    };
}

/** Tools visible for a given mode: docs always; +query in read/write; +invoke in write. */
export function computeTools(mode: Mode): Tool[] {
    const tools: Tool[] = [...DOCS_TOOLS];

    if (mode === 'read' || mode === 'write') {
        tools.push(queryTool());
    }

    if (mode === 'write') {
        tools.push(invokeTool());
    }

    return tools.map((tool) => ({ ...tool, outputSchema: RESULT_SCHEMA }));
}

export type ToolResult = StructuredResult;

export interface CallCtx {
    mode: Mode;
    client?: ActionClient;
    signal?: AbortSignal;
    trace?: TraceContext;
    onProgress?: (progress: TransferProgress) => Promise<void>;
}

export async function callTool(
    name: string,
    args: Record<string, unknown>,
    ctx: CallCtx,
): Promise<ToolResult> {
    switch (name) {
        case 'list_actions':
        case 'search_actions': {
            try {
                return asText(discover(ACTIONS, args, name === 'search_actions'));
            } catch (error) {
                return asError(error instanceof Error ? error.message : String(error));
            }
        }

        case 'get_action': {
            const q = typeof args.name === 'string' ? args.name : '';
            const action = byName.get(q);

            if (!action) {
                return asError(
                    `未找到 action: ${JSON.stringify(q)}。用 list_actions / search_actions 查可用项。`,
                    'not_found',
                    '使用 list_actions / search_actions 查找动作。',
                );
            }

            return asText(action);
        }

        case 'list_categories':
            return asText(CATEGORIES);
        case 'get_runtime_info':
            return runtimeInfo(args, ctx);
        case 'query_action':
            return execute(args, ctx, 'read');
        case 'invoke_action':
            return execute(args, ctx, 'write');
        default:
            return asError(`未知工具: ${name}`, 'not_found', '使用 tools/list 查看可用工具。');
    }
}

export interface PreparedActionCall {
    action: string;
    params: Record<string, unknown>;
    inputFile?: string;
    catalog: CatalogAction;
    client: ActionClient;
    inputSchema: Record<string, unknown>;
}

/** The same side-effect-free gate is used before execution and input collection. */
export function prepareActionCall(
    args: Record<string, unknown>,
    ctx: CallCtx,
    kind: 'read' | 'write',
): PreparedActionCall | ToolResult {
    if (kind === 'write' && ctx.mode !== 'write') {
        return asError(
            '写操作未启用：需设置 SNOWLUMA_MCP_MODE=write。',
            'permission',
            '需要写操作时，请由操作者明确启用 write 模式。',
        );
    }

    if (kind === 'read' && ctx.mode !== 'read' && ctx.mode !== 'write') {
        return asError(
            '执行未启用：需配置 SNOWLUMA_MCP_ENDPOINT。',
            'permission',
            '配置端点并选择 read 或 write 模式后重启 MCP。',
        );
    }

    if (!ctx.client) {
        return asError(
            '未配置 OneBot 端点（SNOWLUMA_MCP_ENDPOINT），无法执行。',
            'configuration',
            '检查 MCP 端点配置。',
        );
    }

    const action = typeof args.action === 'string' ? args.action : '';
    const cat = byName.get(action);

    if (!cat) {
        return asError(
            `未知 action: ${JSON.stringify(action)}。用 list_actions / search_actions 查可用项。`,
            'not_found',
            '使用 list_actions / search_actions 查找动作。',
        );
    }

    if (kind === 'read' && !cat.readOnly) {
        return asError(
            `${action} 是写操作，不能用 query_action；请用 invoke_action（需 SNOWLUMA_MCP_MODE=write）。`,
            'permission',
            '需写模式和 invoke_action；不要通过只读工具绕过写操作限制。',
        );
    }

    if (
        args.params !== undefined &&
        (args.params === null || typeof args.params !== 'object' || Array.isArray(args.params))
    ) {
        return asError('params 必须是对象。');
    }

    const params = (args.params ?? {}) as Record<string, unknown>;
    let inputFile: string | undefined;

    if (args.execution !== undefined) {
        if (
            !args.execution ||
            typeof args.execution !== 'object' ||
            Array.isArray(args.execution)
        ) {
            return asError('execution 必须是对象。');
        }

        const execution = args.execution as Record<string, unknown>;
        const unknown = Object.keys(execution).filter((key) => key !== 'input_file');

        if (unknown.length) {
            return asError(`未知 MCP execution 选项: ${unknown.join(', ')}`);
        }

        if (execution.input_file !== undefined) {
            if (typeof execution.input_file !== 'string' || !execution.input_file.trim()) {
                return asError('execution.input_file 必须是非空字符串。');
            }

            inputFile = execution.input_file;
        }
    }

    if (inputFile && cat.name !== 'upload_file_stream') {
        return asError('execution.input_file 仅可用于 upload_file_stream。');
    }

    const inputSchema =
        inputFile && Array.isArray(cat.inputSchema.required)
            ? {
                  ...cat.inputSchema,
                  required: cat.inputSchema.required.filter(
                      (key) => !MCP_UPLOAD_OWNED_FIELDS.includes(key),
                  ),
              }
            : cat.inputSchema;
    return { action, params, inputFile, catalog: cat, client: ctx.client, inputSchema };
}

/** Shared execution path for query_action (read) / invoke_action (write). */
async function execute(
    args: Record<string, unknown>,
    ctx: CallCtx,
    kind: 'read' | 'write',
): Promise<ToolResult> {
    const prepared = prepareActionCall(args, ctx, kind);

    if ('structuredContent' in prepared) {
        return prepared;
    }

    const { action, params, inputFile, catalog: cat, client } = prepared;

    try {
        ctx.signal?.throwIfAborted();

        if (cat.stream) {
            const result = await client.callStream(action, params, {
                ...(inputFile ? { inputFile } : {}),
                ...(ctx.signal ? { signal: ctx.signal } : {}),
                ...(ctx.trace ? { trace: ctx.trace } : {}),
                ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
            });
            return asText(result, envelopeDiagnostics(result.terminal));
        }

        const result = await client.call(
            action,
            params,
            ctx.signal || ctx.trace
                ? {
                      ...(ctx.signal ? { signal: ctx.signal } : {}),
                      ...(ctx.trace ? { trace: ctx.trace } : {}),
                  }
                : undefined,
        );
        return asText(result, envelopeDiagnostics(result));
    } catch (err) {
        return executionError(action, err, ctx.signal);
    }
}

async function runtimeInfo(args: Record<string, unknown>, ctx: CallCtx): Promise<ToolResult> {
    if (args.check_connection !== undefined && typeof args.check_connection !== 'boolean') {
        return asError('check_connection 必须是布尔值。');
    }

    const enabled = ctx.mode !== 'docs' && !!ctx.client;

    if (args.check_connection && !enabled) {
        return asError(
            '当前模式不能检查连接：需配置端点并启用 read 或 write 模式。',
            'permission',
            '先用 get_runtime_info 查看本地模式，再由操作者配置连接。',
        );
    }

    const overview = {
        mode: ctx.mode,
        execution_enabled: enabled,
        write_enabled: enabled && ctx.mode === 'write',
        catalog: {
            version: VERSION,
            action_count: ACTIONS.length,
            source: 'bundled',
            server_support: 'unknown',
        },
        transport: enabled ? (ctx.client?.info ?? null) : null,
        connection_checked: args.check_connection === true,
    };

    if (!args.check_connection) {
        return asText(overview);
    }

    const checks: Record<string, unknown> = {};
    let outcome: Diagnostics['outcome'] = 'success';

    for (const action of ['get_login_info', 'get_status', 'get_version_info']) {
        const result = await execute({ action }, ctx, 'read');
        checks[action] = result.structuredContent;
        const diagnostics = result.structuredContent.diagnostics;

        if (
            diagnostics.outcome === 'unknown' ||
            (diagnostics.outcome === 'failed' && outcome === 'success')
        ) {
            outcome = diagnostics.outcome;
        }
    }

    return asText(
        { ...overview, checks },
        outcome === 'success'
            ? { outcome }
            : { outcome, next_step: '查看 checks 中各项诊断；目录版本不等于服务端能力声明。' },
    );
}
