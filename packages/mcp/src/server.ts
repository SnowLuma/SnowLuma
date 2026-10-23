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
//   SNOWLUMA_MCP_TIMEOUT_MS  ordinary request timeout; Stream connection and
//                            per-read idle timeout (default 30s).
//   SNOWLUMA_MCP_MODE        docs | read | write. Default: read when an
//                            endpoint is set, else docs.
//   SNOWLUMA_MCP_STREAM_DIR  MCP-host directory for completed downloads.
//   SNOWLUMA_MCP_UPLOAD_ROOT Existing MCP-host directory allowed for uploads.
//   SNOWLUMA_MCP_MAX_STREAM_BYTES  Per-file cap (1..4 GiB; default 4 GiB).
//
// NOTE: stdout is the MCP protocol channel — all diagnostics go to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ACTIONS, CATEGORIES } from './generated/catalog.js';
import {
    makeHttpClient,
    parseMaxStreamBytes,
    parseTimeoutMs,
    type ActionClient,
} from './client.js';
import { parseMode, type Mode } from './tools.js';

import { createMcpServer } from './server-factory.js';
import { VERSION } from './version.js';

// ── resolve mode + client from the environment ────────────────────────────
function resolveRuntime(): { mode: Mode; client?: ActionClient } {
    const endpoint = process.env.SNOWLUMA_MCP_ENDPOINT?.trim();
    const token = process.env.SNOWLUMA_MCP_TOKEN?.trim() || undefined;
    const streamDir = process.env.SNOWLUMA_MCP_STREAM_DIR?.trim() || undefined;
    const uploadRoot = process.env.SNOWLUMA_MCP_UPLOAD_ROOT?.trim() || undefined;
    const maxStreamBytes = parseMaxStreamBytes(process.env.SNOWLUMA_MCP_MAX_STREAM_BYTES);
    const timeoutMs = parseTimeoutMs(process.env.SNOWLUMA_MCP_TIMEOUT_MS);
    const requested = parseMode(process.env.SNOWLUMA_MCP_MODE);

    if (!endpoint) {
        if (requested && requested !== 'docs') {
            console.error(
                `[snowluma-mcp] SNOWLUMA_MCP_MODE=${requested} ignored: no SNOWLUMA_MCP_ENDPOINT set — docs-only.`,
            );
        }

        return { mode: 'docs' };
    }

    const mode: Mode = requested ?? 'read';

    if (mode === 'docs') {
        // Endpoint set but operator explicitly wants docs-only — honor it.
        return { mode: 'docs' };
    }

    const client = makeHttpClient({
        endpoint,
        accessToken: token,
        timeoutMs,
        streamDir,
        uploadRoot,
        maxStreamBytes,
    });
    return { mode, client };
}

const { mode, client } = resolveRuntime();

const server = createMcpServer({ mode, client });

const transport = new StdioServerTransport();
await server.connect(transport);
const where = client ? ` → ${process.env.SNOWLUMA_MCP_ENDPOINT?.trim()}` : '';
console.error(
    `[snowluma-mcp] v${VERSION} ready — ${ACTIONS.length} actions, ${CATEGORIES.length} categories, mode=${mode}${where}`,
);
