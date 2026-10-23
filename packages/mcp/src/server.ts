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
//   SNOWLUMA_MCP_TASK_DIR    Private persistent task directory (write mode only).
//   SNOWLUMA_MCP_EVENTS_URL Explicit OneBot event WebSocket endpoint.
//
// NOTE: stdout is the MCP protocol channel — all diagnostics go to stderr.

import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createHash } from 'node:crypto';
import { ACTIONS, CATEGORIES } from './generated/catalog.js';
import {
    makeHttpClient,
    parseMaxStreamBytes,
    parseTimeoutMs,
    type ActionClient,
} from './client.js';
import { parseMode, type Mode } from './tools.js';

import { createMcpServer, type McpServerOptions } from './server-factory.js';
import { createInputCompletion } from './elicitation.js';
import { PersistentTasks } from './tasks.js';
import { shutdownRuntime } from './shutdown.js';
import { normalizeEventSubscriptionOptions } from './subscriptions.js';
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

const runtime: McpServerOptions = resolveRuntime();
const { mode } = runtime;
const taskDirectory = process.env.SNOWLUMA_MCP_TASK_DIR?.trim();
const eventsUrl = process.env.SNOWLUMA_MCP_EVENTS_URL?.trim();

if (taskDirectory && mode !== 'write') {
    throw new Error('SNOWLUMA_MCP_TASK_DIR requires write mode and a configured endpoint');
}

if (eventsUrl && mode !== 'docs') {
    runtime.events = normalizeEventSubscriptionOptions({
        url: eventsUrl,
        accessToken: process.env.SNOWLUMA_MCP_TOKEN?.trim() || undefined,
        timeoutMs: parseTimeoutMs(process.env.SNOWLUMA_MCP_TIMEOUT_MS),
    });
}

if (taskDirectory) {
    const scopeId = createHash('sha256')
        .update(
            JSON.stringify({
                mode,
                endpoint: process.env.SNOWLUMA_MCP_ENDPOINT?.trim(),
                token: process.env.SNOWLUMA_MCP_TOKEN?.trim() || null,
            }),
        )
        .digest('hex');
    runtime.tasks = await PersistentTasks.open(taskDirectory, {
        scopeId,
        onChange: (task) =>
            console.error(
                '[snowluma-mcp] %s',
                JSON.stringify({ event: 'task_status', task_id: task.taskId, status: task.status }),
            ),
        onError: (_error, context) => {
            console.error('[snowluma-mcp] %s', JSON.stringify(context));
        },
    });
}

const inputCompletion = createInputCompletion();
runtime.inputCompletion = inputCompletion;
let cleanup: Promise<void> | undefined;

function closeFeatures(): Promise<void> {
    return (cleanup ??= (async () => {
        inputCompletion.close();
        await runtime.tasks?.close();
    })());
}

function reportShutdownError(error: unknown): void {
    console.error(
        '[snowluma-mcp] shutdown failed: %s',
        error instanceof Error ? error.name : 'unknown',
    );
    process.exitCode = 1;
}

const transport = new StdioServerTransport();
const handle = serveStdio(() => createMcpServer(runtime), {
    transport,
    onerror: (error) => {
        // Protocol errors may embed client input. Keep the error category visible
        // without copying arguments or credentials into process diagnostics.
        console.error('[snowluma-mcp] protocol error: %s', error.name);
    },
});
const transportClosed = transport.onclose;

transport.onclose = () => {
    transportClosed?.();
    void closeFeatures().catch(reportShutdownError);
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        void shutdownRuntime({
            closeFeatures,
            closeProtocol: () => handle.close(),
            forceClose: async () => {
                await transport.close();
                process.stdout.destroy();
            },
            onLateProtocolError: reportShutdownError,
        }).catch(reportShutdownError);
    });
}

console.error(
    `[snowluma-mcp] v${VERSION} ready — ${ACTIONS.length} actions, ${CATEGORIES.length} categories, mode=${mode}`,
);
