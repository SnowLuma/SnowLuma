import {
    Server,
    ProtocolError,
    isInputRequiredResult,
    isSpecType,
    type ServerContext,
    type Tool,
} from '@modelcontextprotocol/server';
import { ACTIONS, CATEGORIES } from './generated/catalog.js';
import { callTool, computeTools, prepareActionCall, type CallCtx } from './tools.js';
import { createProgressReporter } from './progress.js';
import { VERSION } from './version.js';
import { createCallTrace } from './tracing.js';
import {
    createInputCompletion,
    inputCompletionBaseTool,
    inputCompletionTools,
    isInputCompletionTool,
    type InputCompletion,
} from './elicitation.js';
import {
    MESSAGE_PREVIEW_TOOL,
    messageAppResources,
    messagePreviewTool,
    previewMessage,
    readMessageAppResource,
    supportsMessageApp,
} from './message-app.js';
import { EventSubscriptions, EVENT_TOOLS, type EventSubscriptionOptions } from './subscriptions.js';
import {
    installTaskHandlers,
    supportsTasks,
    type PersistentTasks,
    type TaskHandle,
} from './tasks.js';
import { asError, asText, RESULT_SCHEMA, type StructuredResult } from './results.js';

export interface McpServerOptions extends Pick<CallCtx, 'mode' | 'client'> {
    inputCompletion?: InputCompletion;
    tasks?: PersistentTasks;
    events?: EventSubscriptionOptions;
}

const RESOURCE_URI = 'snowluma://onebot/actions';

export function createMcpServer(ctx: McpServerOptions): Server {
    const input = ctx.inputCompletion ?? createInputCompletion();
    const events =
        ctx.mode !== 'docs' && ctx.events ? new EventSubscriptions(ctx.events) : undefined;
    const legacySubscriptions = new Set<string>();
    const server = new Server(
        { name: 'snowluma-mcp', version: VERSION },
        {
            capabilities: {
                tools: {},
                resources: events ? { subscribe: true, listChanged: true } : {},
                extensions: { 'io.modelcontextprotocol/ui': {} },
            },
            requestState: { verify: input.verifyRequestState },
            // Tool availability depends on the configured mode; only the bundled
            // action catalog is public. Execution and account data are never cached.
            cacheHints: {
                'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
                'resources/list': { ttlMs: events ? 0 : 300_000, cacheScope: 'private' },
                'resources/read': { ttlMs: 0, cacheScope: 'private' },
                'resources/templates/list': { ttlMs: 300_000, cacheScope: 'public' },
            },
        },
    );

    const capabilities = (request: ServerContext) => {
        const envelope: Record<string, unknown> | undefined = request.mcpReq.envelope;

        if (!envelope) {
            return server.getClientCapabilities();
        }

        const value = envelope['io.modelcontextprotocol/clientCapabilities'];

        if (!isSpecType.ClientCapabilities(value)) {
            throw new ProtocolError(-32602, 'Invalid client capabilities');
        }

        return value;
    };

    const cacheMetadata = (scope: 'public' | 'private') =>
        (server.getNegotiatedProtocolVersion() ?? '') >= '2026-07-28'
            ? { ttlMs: scope === 'public' ? 300_000 : 0, cacheScope: scope }
            : {};
    const taskEnabled = (request: ServerContext) =>
        !!ctx.tasks &&
        ctx.mode === 'write' &&
        (server.getNegotiatedProtocolVersion() ?? '') >= '2026-07-28' &&
        supportsTasks(request.mcpReq.envelope);

    const availableTools = (request: ServerContext): Tool[] => {
        const base = computeTools(ctx.mode);
        const extra = [
            ...inputCompletionTools(base),
            messagePreviewTool(supportsMessageApp(capabilities(request))),
            ...(events ? EVENT_TOOLS : []),
        ];

        if (taskEnabled(request)) {
            const invocation = base.find((tool) => tool.name === 'invoke_action')!;
            extra.push(
                {
                    ...invocation,
                    name: 'invoke_action_background',
                    description:
                        '在后台执行一个流式传输动作，返回可跨重启查询的任务编号。仅限流式动作和写模式；重启不会自动重放未完成操作。',
                },
                {
                    name: 'list_tasks',
                    description: '列出本配置下持久化任务的编号和状态，不返回结果正文。',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            cursor: { type: 'string' },
                            limit: { type: 'integer', minimum: 1, maximum: 100 },
                        },
                        additionalProperties: false,
                    },
                    outputSchema: RESULT_SCHEMA,
                    annotations: { readOnlyHint: true, openWorldHint: false },
                },
            );
        }

        return [...base, ...extra];
    };

    if (ctx.tasks && ctx.mode === 'write') {
        installTaskHandlers(server, ctx.tasks);
    }

    events?.onUpdate(async (uri) => {
        if (
            (server.getNegotiatedProtocolVersion() ?? '') >= '2026-07-28' ||
            legacySubscriptions.has(uri)
        ) {
            await server.sendResourceUpdated({ uri });
        }
    });

    server.onclose = () => {
        events?.close();
        legacySubscriptions.clear();

        if (!ctx.inputCompletion) {
            input.close();
        }
    };

    server.setRequestHandler('tools/list', async (_req, request) => ({
        tools: availableTools(request),
    }));
    server.setRequestHandler('tools/call', async (req, request) => {
        const { mcpReq } = request;
        const trace = createCallTrace(mcpReq._meta);
        const tool = availableTools(request).some((entry) => entry.name === req.params.name)
            ? req.params.name
            : 'unlisted';
        const started = performance.now();

        const report = (event: string, outcome?: string, kind?: string, taskId?: string) => {
            console.error(
                '[snowluma-mcp] %s',
                JSON.stringify({
                    event,
                    tool,
                    traceparent: trace.traceparent,
                    ...(outcome
                        ? { outcome, duration_ms: Math.round(performance.now() - started) }
                        : {}),
                    ...(kind ? { kind } : {}),
                    ...(taskId ? { task_id: taskId } : {}),
                }),
            );
        };

        report('call_started');
        const token = mcpReq._meta?.progressToken;
        const progress =
            token === undefined
                ? undefined
                : createProgressReporter(
                      (value) =>
                          mcpReq.notify({
                              method: 'notifications/progress',
                              params: { progressToken: token, ...value },
                          }),
                      mcpReq.signal,
                  );

        try {
            const args = req.params.arguments ?? {};
            const callContext: CallCtx = {
                mode: ctx.mode,
                client: ctx.client,
                signal: mcpReq.signal,
                trace,
                ...(progress ? { onProgress: progress.report } : {}),
            };

            const dispatch = async (): Promise<
                StructuredResult | TaskHandle | Awaited<ReturnType<InputCompletion['handle']>>
            > => {
                if (isInputCompletionTool(req.params.name)) {
                    const base = inputCompletionBaseTool(req.params.name);
                    return input.handle(req.params.name, args, request, {
                        capabilities: capabilities(request),
                        preflight: (values) => {
                            const prepared = prepareActionCall(
                                values,
                                callContext,
                                base === 'query_action' ? 'read' : 'write',
                            );
                            return 'structuredContent' in prepared
                                ? prepared
                                : {
                                      action: prepared.action,
                                      params: prepared.params,
                                      inputSchema: prepared.inputSchema,
                                  };
                        },
                        execute: (values) => callTool(base, values, callContext),
                    });
                }

                if (req.params.name === MESSAGE_PREVIEW_TOOL) {
                    return previewMessage(args, ctx.mode === 'write' && !!ctx.client);
                }

                if (events?.handlesTool(req.params.name)) {
                    const result = await events.callTool(req.params.name, args, mcpReq.signal);

                    if (!result.isError) {
                        if (
                            req.params.name === 'unsubscribe_events' &&
                            typeof args.uri === 'string'
                        ) {
                            legacySubscriptions.delete(args.uri);
                        }

                        await server.sendResourceListChanged();
                    }

                    return result;
                }

                if (
                    req.params.name === 'invoke_action_background' ||
                    req.params.name === 'list_tasks'
                ) {
                    if (!taskEnabled(request) || !ctx.tasks) {
                        return asError(
                            '持久任务需配置任务目录、启用写模式，并由客户端声明新版任务能力。',
                            'configuration',
                        );
                    }

                    if (req.params.name === 'list_tasks') {
                        if (
                            Object.keys(args).some((key) => key !== 'cursor' && key !== 'limit') ||
                            (args.cursor !== undefined && typeof args.cursor !== 'string') ||
                            (args.limit !== undefined && typeof args.limit !== 'number')
                        ) {
                            return asError('任务列表参数无效。');
                        }

                        return asText(
                            ctx.tasks.list({
                                cursor: args.cursor as string | undefined,
                                limit: args.limit as number | undefined,
                            }),
                        );
                    }

                    const prepared = prepareActionCall(args, callContext, 'write');

                    if ('structuredContent' in prepared) {
                        return prepared;
                    }

                    if (!prepared.catalog.stream) {
                        return asError('后台任务仅支持流式传输动作；普通动作请使用原执行工具。');
                    }

                    mcpReq.signal.throwIfAborted();
                    return ctx.tasks.start(async ({ signal }) =>
                        callTool('invoke_action', args, {
                            mode: ctx.mode,
                            client: ctx.client,
                            signal,
                            trace,
                        }),
                    );
                }

                return callTool(req.params.name, args, callContext);
            };

            const result = await dispatch();

            if (isInputRequiredResult(result)) {
                report('call_input_required', 'unknown');
                return { ...result, _meta: { traceparent: trace.traceparent } };
            }

            if (!('structuredContent' in result)) {
                report('call_detached', 'unknown', undefined, result.taskId);
                return { ...result, _meta: { traceparent: trace.traceparent } };
            }

            if (!result.isError) {
                await progress?.finish();
            }

            const { outcome, kind } = result.structuredContent.diagnostics;
            report(
                mcpReq.signal.aborted || kind === 'cancelled' ? 'call_cancelled' : 'call_finished',
                outcome,
                kind,
            );
            return { ...result, _meta: { ...result._meta, traceparent: trace.traceparent } };
        } catch (error) {
            report(mcpReq.signal.aborted ? 'call_cancelled' : 'call_failed', 'unknown');
            throw error;
        }
    });
    server.setRequestHandler('resources/list', async (_req, request) => ({
        resources: [
            {
                uri: RESOURCE_URI,
                name: 'SnowLuma OneBot action catalog',
                mimeType: 'application/json',
                description: `SnowLuma v${VERSION} 的 ${ACTIONS.length} 个 OneBot action 完整目录（文档 + JSON Schema）。`,
            },
            ...messageAppResources(supportsMessageApp(capabilities(request))),
            ...(events?.resources() ?? []),
        ],
    }));
    server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [] }));
    server.setRequestHandler('resources/read', async (req) => {
        if (events?.ownsUri(req.params.uri)) {
            return { ...events.readResource(req.params.uri), ...cacheMetadata('private') };
        }

        const app = await readMessageAppResource(req.params.uri);

        if (app) {
            return { ...app, ...cacheMetadata('public') };
        }

        if (req.params.uri !== RESOURCE_URI) {
            throw new Error(`unknown resource: ${req.params.uri}`);
        }

        return {
            ...cacheMetadata('public'),
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

    if (events) {
        server.setRequestHandler('resources/subscribe', async (req) => {
            if (!events.resources().some((resource) => resource.uri === req.params.uri)) {
                throw new ProtocolError(-32602, 'Subscribe using the canonical event resource URI');
            }

            events.readResource(req.params.uri);
            legacySubscriptions.add(req.params.uri);
            return {};
        });
        server.setRequestHandler('resources/unsubscribe', async (req) => {
            if (!events.ownsUri(req.params.uri)) {
                throw new ProtocolError(-32602, 'Unknown event resource');
            }

            events.remove(req.params.uri);
            legacySubscriptions.delete(req.params.uri);
            await server.sendResourceListChanged();
            return {};
        });
    }

    return server;
}
