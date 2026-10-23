import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ACTIONS, CATEGORIES } from './generated/catalog.js';
import { callTool, computeTools, type CallCtx } from './tools.js';
import { createProgressReporter } from './progress.js';
import { VERSION } from './version.js';

const RESOURCE_URI = 'snowluma://onebot/actions';

export function createMcpServer(ctx: Pick<CallCtx, 'mode' | 'client'>): Server {
    const server = new Server(
        { name: 'snowluma-mcp', version: VERSION },
        { capabilities: { tools: {}, resources: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: computeTools(ctx.mode),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
        const token = req.params._meta?.progressToken;
        const progress =
            token === undefined
                ? undefined
                : createProgressReporter(
                      (value) =>
                          extra.sendNotification({
                              method: 'notifications/progress',
                              params: { progressToken: token, ...value },
                          }),
                      extra.signal,
                  );
        const result = await callTool(req.params.name, req.params.arguments ?? {}, {
            ...ctx,
            signal: extra.signal,
            ...(progress ? { onProgress: progress.report } : {}),
        });

        if (!result.isError) {
            await progress?.finish();
        }

        return result;
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
        if (req.params.uri !== RESOURCE_URI) {
            throw new Error(`unknown resource: ${req.params.uri}`);
        }

        return {
            contents: [
                {
                    uri: RESOURCE_URI,
                    mimeType: 'application/json',
                    text: JSON.stringify(
                        { version: VERSION, categories: CATEGORIES, actions: ACTIONS },
                        null,
                        2,
                    ),
                },
            ],
        };
    });
    return server;
}
