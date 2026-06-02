#!/usr/bin/env node
// @snowluma/mcp — a read-only MCP server that exposes the SnowLuma OneBot action
// catalog (docs + per-action JSON Schemas) to LLM clients over stdio.
//
// The catalog is a build-time snapshot (src/generated/catalog.ts), regenerated
// from @snowluma/onebot's live action specs on every build — so it auto-tracks
// action add/remove and ships zero runtime dependency on onebot.
//
// NOTE: stdout is the MCP protocol channel — all diagnostics go to stderr.

import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ACTIONS, CATEGORIES } from './generated/catalog.js';
import type { CatalogAction } from './types.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const VERSION = pkg.version;

const RESOURCE_URI = 'snowluma://onebot/actions';

// name + every alias → the action, so get_action accepts aliases too.
const byName = new Map<string, CatalogAction>();
for (const a of ACTIONS) {
  for (const n of [a.name, ...a.aliases]) byName.set(n, a);
}

/** Lightweight index entry (keeps list/search payloads small). */
function lite(a: CatalogAction) {
  return { name: a.name, category: a.category, summary: a.summary, aliases: a.aliases };
}

const TOOLS = [
  {
    name: 'list_actions',
    description: '列出所有 OneBot action（可按 category 过滤）。返回轻量索引（名称/分类/摘要/别名）。',
    inputSchema: {
      type: 'object',
      properties: { category: { type: 'string', description: '按分类过滤，如 群管理 / 消息 / 好友' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_action',
    description: '获取某个 OneBot action 的完整文档：摘要、参数表、跨字段约束、返回，以及可直接用于构造调用的参数 JSON Schema（inputSchema）。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'action 名（接受别名）' } },
      required: ['name'],
      additionalProperties: false,
    },
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
  },
  {
    name: 'list_categories',
    description: '列出所有分类及其 action 数量。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function asText(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function asError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

const server = new Server(
  { name: 'snowluma-mcp', version: VERSION },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
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
    default:
      return asError(`未知工具: ${name}`);
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: RESOURCE_URI,
      name: 'SnowLuma OneBot action catalog',
      mimeType: 'application/json',
      description: `SnowLuma v${VERSION} 的 ${ACTIONS.length} 个 OneBot action 完整目录（文档 + JSON Schema）。`,
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== RESOURCE_URI) throw new Error(`unknown resource: ${req.params.uri}`);
  return {
    contents: [
      {
        uri: RESOURCE_URI,
        mimeType: 'application/json',
        text: JSON.stringify({ version: VERSION, categories: CATEGORIES, actions: ACTIONS }, null, 2),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[snowluma-mcp] v${VERSION} ready — ${ACTIONS.length} actions, ${CATEGORIES.length} categories`);
