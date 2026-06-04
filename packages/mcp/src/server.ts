#!/usr/bin/env node
// @snowluma/mcp — an MCP server for the SnowLuma OneBot action catalog.
//
// Two modes in one binary:
//   • docs  (default, no endpoint): read-only catalog tools (list/get/search/
//     categories) + a catalog resource. Zero contact with any live instance.
//   • read / write (when SNOWLUMA_MCP_ENDPOINT is set): the catalog tools PLUS
//     execution — query_action (read-only actions) and, in write mode,
//     invoke_action (any known action) — proxied to a running OneBot instance
//     over HTTP.
//
// Env:
//   SNOWLUMA_MCP_ENDPOINT    OneBot HTTP endpoint (e.g. http://127.0.0.1:3000/).
//                            Absent → docs-only (execution tools hidden).
//   SNOWLUMA_MCP_TOKEN       access token (Bearer) for the endpoint.
//   SNOWLUMA_MCP_TIMEOUT_MS  per-request timeout (default SDK 30s).
//   SNOWLUMA_MCP_MODE        docs | read | write. Default: read when an
//                            endpoint is set, else docs.
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
import { makeHttpClient, type ActionClient } from './client.js';
import { callTool, computeTools, type Mode } from './tools.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const VERSION = pkg.version;

const RESOURCE_URI = 'snowluma://onebot/actions';

// ── resolve mode + client from the environment ────────────────────────────
function resolveRuntime(): { mode: Mode; client?: ActionClient } {
  const endpoint = process.env.SNOWLUMA_MCP_ENDPOINT?.trim();
  const token = process.env.SNOWLUMA_MCP_TOKEN?.trim() || undefined;
  const timeoutRaw = Number(process.env.SNOWLUMA_MCP_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined;
  const requested = process.env.SNOWLUMA_MCP_MODE?.trim().toLowerCase();
  const validRequest = requested === 'docs' || requested === 'read' || requested === 'write' ? requested : undefined;

  if (!endpoint) {
    if (validRequest && validRequest !== 'docs') {
      console.error(`[snowluma-mcp] SNOWLUMA_MCP_MODE=${validRequest} ignored: no SNOWLUMA_MCP_ENDPOINT set — docs-only.`);
    }
    return { mode: 'docs' };
  }

  const mode: Mode = validRequest ?? 'read';
  if (mode === 'docs') {
    // Endpoint set but operator explicitly wants docs-only — honor it.
    return { mode: 'docs' };
  }
  const client = makeHttpClient({ endpoint, accessToken: token, timeoutMs });
  return { mode, client };
}

const { mode, client } = resolveRuntime();

const server = new Server(
  { name: 'snowluma-mcp', version: VERSION },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: computeTools(mode) }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  return callTool(req.params.name, args, { mode, client });
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
const where = client ? ` → ${process.env.SNOWLUMA_MCP_ENDPOINT?.trim()}` : '';
console.error(`[snowluma-mcp] v${VERSION} ready — ${ACTIONS.length} actions, ${CATEGORIES.length} categories, mode=${mode}${where}`);
