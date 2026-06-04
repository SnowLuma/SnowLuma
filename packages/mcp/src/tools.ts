// Tool surface for the MCP — kept free of any stdio / transport / env concerns
// so it is directly unit-testable. `server.ts` reads the environment, builds a
// client, and wires `computeTools` / `callTool` into the MCP request handlers.
//
// Two execution tools partition the action space by side-effect:
//   • query_action  — read-only actions only   (readOnlyHint)
//   • invoke_action — any known action          (destructiveHint, write mode)
// Visibility is gated by `mode`, and `callTool` RE-checks every permission
// (defense in depth: a client may call a tool that was never listed).

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { ACTIONS, CATEGORIES } from './generated/catalog.js';
import type { CatalogAction } from './types.js';
import type { ActionClient } from './client.js';

export type Mode = 'docs' | 'read' | 'write';

// name + every alias → action, so lookups accept aliases too.
const byName = new Map<string, CatalogAction>();
for (const a of ACTIONS) {
  for (const n of [a.name, ...a.aliases]) byName.set(n, a);
}

/** Lightweight index entry (keeps list/search payloads small). */
function lite(a: CatalogAction) {
  return { name: a.name, category: a.category, summary: a.summary, aliases: a.aliases, readOnly: a.readOnly };
}

const DOCS_TOOLS: Tool[] = [
  {
    name: 'list_actions',
    description: '列出所有 OneBot action（可按 category 过滤）。返回轻量索引（名称/分类/摘要/别名/是否只读）。',
    inputSchema: {
      type: 'object',
      properties: { category: { type: 'string', description: '按分类过滤，如 群管理 / 消息 / 好友' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_action',
    description: '获取某个 OneBot action 的完整文档：摘要、参数表、跨字段约束、返回、是否只读，以及可直接用于构造调用的参数 JSON Schema（inputSchema）。',
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
    description: '按关键字模糊搜索 action（匹配名称 / 摘要 / 别名）。返回轻量索引。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '关键字' } },
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
];

const EXEC_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    action: { type: 'string', description: 'action 名（接受别名）。先用 get_action 查它的参数 inputSchema。' },
    params: { type: 'object', description: '该 action 的参数对象', additionalProperties: true },
  },
  required: ['action'],
  additionalProperties: false,
};

function queryTool(): Tool {
  return {
    name: 'query_action',
    description: '调用一个【只读】OneBot action（如 get_*/can_*）并返回完整响应。仅接受只读 action；写操作请用 invoke_action。',
    inputSchema: EXEC_INPUT_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: true },
  };
}

function invokeTool(): Tool {
  return {
    name: 'invoke_action',
    description: '调用一个 OneBot action（可产生副作用：发消息、改群、改资料等）并返回完整响应。仅在写模式可用。',
    inputSchema: EXEC_INPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  };
}

/** Tools visible for a given mode: docs always; +query in read/write; +invoke in write. */
export function computeTools(mode: Mode): Tool[] {
  const tools: Tool[] = [...DOCS_TOOLS];
  if (mode === 'read' || mode === 'write') tools.push(queryTool());
  if (mode === 'write') tools.push(invokeTool());
  return tools;
}

export type ToolResult = CallToolResult;

function asText(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function asError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export interface CallCtx {
  mode: Mode;
  client?: ActionClient;
}

export async function callTool(name: string, args: Record<string, unknown>, ctx: CallCtx): Promise<ToolResult> {
  switch (name) {
    case 'list_actions': {
      const category = typeof args.category === 'string' ? args.category : undefined;
      const list = ACTIONS.filter((a) => !category || a.category === category).map(lite);
      return asText({ count: list.length, actions: list });
    }
    case 'get_action': {
      const q = typeof args.name === 'string' ? args.name : '';
      const action = byName.get(q);
      if (!action) return asError(`未找到 action: ${JSON.stringify(q)}。用 list_actions / search_actions 查可用项。`);
      return asText(action);
    }
    case 'search_actions': {
      const q = (typeof args.query === 'string' ? args.query : '').toLowerCase();
      const list = ACTIONS.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.summary ?? '').toLowerCase().includes(q) ||
          a.aliases.some((al) => al.toLowerCase().includes(q)),
      ).map(lite);
      return asText({ count: list.length, actions: list });
    }
    case 'list_categories':
      return asText(CATEGORIES);
    case 'query_action':
      return execute(args, ctx, 'read');
    case 'invoke_action':
      return execute(args, ctx, 'write');
    default:
      return asError(`未知工具: ${name}`);
  }
}

/** Shared execution path for query_action (read) / invoke_action (write).
 *  Re-checks mode + readOnly routing regardless of which tools were listed. */
async function execute(args: Record<string, unknown>, ctx: CallCtx, kind: 'read' | 'write'): Promise<ToolResult> {
  if (kind === 'write' && ctx.mode !== 'write') {
    return asError('写操作未启用：需设置 SNOWLUMA_MCP_MODE=write。');
  }
  if (kind === 'read' && ctx.mode !== 'read' && ctx.mode !== 'write') {
    return asError('执行未启用：需配置 SNOWLUMA_MCP_ENDPOINT。');
  }
  if (!ctx.client) return asError('未配置 OneBot 端点（SNOWLUMA_MCP_ENDPOINT），无法执行。');

  const action = typeof args.action === 'string' ? args.action : '';
  const cat = byName.get(action);
  if (!cat) return asError(`未知 action: ${JSON.stringify(action)}。用 list_actions / search_actions 查可用项。`);
  if (kind === 'read' && !cat.readOnly) {
    return asError(`${action} 是写操作，不能用 query_action；请用 invoke_action（需 SNOWLUMA_MCP_MODE=write）。`);
  }

  const params =
    args.params && typeof args.params === 'object' && !Array.isArray(args.params)
      ? (args.params as Record<string, unknown>)
      : {};
  try {
    const envelope = await ctx.client.call(action, params);
    return asText(envelope);
  } catch (err) {
    return asError(`调用失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
