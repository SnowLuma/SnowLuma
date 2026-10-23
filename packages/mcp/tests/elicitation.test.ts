import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, Server, type ClientCapabilities } from '@modelcontextprotocol/server';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
    createInputCompletion,
    inputCompletionBaseTool,
    inputCompletionTools,
    isInputCompletionTool,
} from '../src/elicitation';
import { asError, asText } from '../src/results';
import { computeTools, prepareActionCall, type Mode } from '../src/tools';
import type { ActionClient } from '../src/client';
import { createMcpServer } from '../src/server-factory';

const cleanup: Array<() => void | Promise<void>> = [];
const completeCapabilities: ClientCapabilities = { elicitation: { form: {} } };
const ORIGINAL = { action: 'send_private_msg', params: { message: 'private original message' } };

afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }

    vi.useRealTimers();
    vi.restoreAllMocks();
});

function harness(options: Parameters<typeof createInputCompletion>[0] = {}, mode: Mode = 'write') {
    const completion = createInputCompletion(options);
    const execute = vi.fn(async (args: Record<string, unknown>) => asText(args.params));
    const client: ActionClient = {
        call: vi.fn(async () => ({ status: 'ok', retcode: 0 })),
        callStream: vi.fn(async () => ({
            frame_count: 1,
            frames: [],
            terminal: { status: 'ok', retcode: 0 },
        })),
    };
    const preflight = vi.fn((args: Record<string, unknown>, kind: 'read' | 'write') => {
        const result = prepareActionCall(args, { mode, client }, kind);
        return 'structuredContent' in result
            ? result
            : {
                  action: result.action,
                  params: result.params,
                  inputSchema: result.inputSchema,
              };
    });

    const factory = () => {
        const server = new Server(
            { name: 'input-test', version: '1' },
            {
                capabilities: { tools: {} },
                requestState: { verify: completion.verifyRequestState },
            },
        );
        server.setRequestHandler('tools/list', async () => ({
            tools: inputCompletionTools(computeTools('write')),
        }));
        server.setRequestHandler('tools/call', (request, context) => {
            if (!isInputCompletionTool(request.params.name)) {
                return asError('unknown tool');
            }

            const name = request.params.name;
            return completion.handle(name, request.params.arguments ?? {}, context, {
                capabilities:
                    context.mcpReq.envelope?.['io.modelcontextprotocol/clientCapabilities'] ??
                    server.getClientCapabilities(),
                preflight: (args) =>
                    preflight(
                        args,
                        inputCompletionBaseTool(name) === 'query_action' ? 'read' : 'write',
                    ),
                execute,
            });
        });
        return server;
    };

    const handler = createMcpHandler(factory);
    cleanup.push(
        () => completion.close(),
        () => handler.close(),
    );

    async function raw(
        arguments_: Record<string, unknown> = ORIGINAL,
        retry: Record<string, unknown> = {},
        capabilities: ClientCapabilities = completeCapabilities,
        name = 'invoke_action_with_input',
        token?: string,
    ) {
        const response = await handler.fetch(
            new Request('http://input.invalid/mcp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'Mcp-Method': 'tools/call',
                    'Mcp-Name': name,
                    'Mcp-Protocol-Version': '2026-07-28',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {
                        name,
                        arguments: arguments_,
                        ...retry,
                        _meta: {
                            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                            'io.modelcontextprotocol/clientCapabilities': capabilities,
                            'io.modelcontextprotocol/clientInfo': {
                                name: 'input-test',
                                version: '1',
                            },
                        },
                    },
                }),
            }),
            token ? { authInfo: { token, clientId: 'test-app', scopes: [] } } : undefined,
        );
        return response.json();
    }

    return { completion, handler, factory, execute, preflight, raw };
}

function answer(requestState: string, content: unknown = { params_json: '{"user_id":123}' }) {
    return { requestState, inputResponses: { missing_parameters: { action: 'accept', content } } };
}

describe('optional action input completion', () => {
    it('integrates with the production factory and preserves the original action result contract', async () => {
        const completion = createInputCompletion();
        const onebot: ActionClient = {
            call: vi.fn(async () => ({ status: 'ok', retcode: 0, data: { message_id: -42 } })),
            callStream: vi.fn(),
        };
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const handler = createMcpHandler(() =>
            createMcpServer({ mode: 'write', client: onebot, inputCompletion: completion }),
        );
        const client = new Client(
            { name: 'production-input-test', version: '1' },
            {
                capabilities: completeCapabilities,
                versionNegotiation: { mode: { pin: '2026-07-28' } },
            },
        );
        client.setRequestHandler('elicitation/create', async () => {
            expect(onebot.call).not.toHaveBeenCalled();
            return { action: 'accept', content: { params_json: '{"user_id":123}' } };
        });
        cleanup.push(
            () => completion.close(),
            () => handler.close(),
            () => client.close(),
        );
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://input.invalid/mcp'), {
                fetch: (input, init) => handler.fetch(new Request(input, init)),
            }),
        );
        const result = await client.callTool({
            name: 'invoke_action_with_input',
            arguments: ORIGINAL,
        });
        expect(result.structuredContent).toEqual({
            result: { status: 'ok', retcode: 0, data: { message_id: -42 } },
            diagnostics: { outcome: 'success' },
        });
        expect(onebot.call).toHaveBeenCalledExactlyOnceWith(
            'send_private_msg',
            { user_id: 123, message: ORIGINAL.params.message },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(JSON.stringify(log.mock.calls)).not.toContain(ORIGINAL.params.message);
        expect(log.mock.calls.map(([, value]) => JSON.parse(String(value)).event)).toEqual([
            'call_started',
            'call_input_required',
            'call_started',
            'call_finished',
        ]);
    });

    it.each(['docs', 'read'] as const)(
        'keeps the production factory mode gate before input collection in %s mode',
        async (mode) => {
            const onebot: ActionClient = { call: vi.fn(), callStream: vi.fn() };
            const log = vi.spyOn(console, 'error').mockImplementation(() => {});
            const handler = createMcpHandler(() => createMcpServer({ mode, client: onebot }));
            const client = new Client(
                { name: 'permission-input-test', version: '1' },
                {
                    capabilities: completeCapabilities,
                    versionNegotiation: { mode: { pin: '2026-07-28' } },
                },
            );
            const ask = vi.fn(async () => ({
                action: 'accept' as const,
                content: { params_json: '{"user_id":123}' },
            }));
            client.setRequestHandler('elicitation/create', ask);
            cleanup.push(
                () => handler.close(),
                () => client.close(),
            );
            await client.connect(
                new StreamableHTTPClientTransport(new URL('http://input.invalid/mcp'), {
                    fetch: (input, init) => handler.fetch(new Request(input, init)),
                }),
            );
            const result = await client.callTool({
                name: 'invoke_action_with_input',
                arguments: ORIGINAL,
            });
            expect(result.structuredContent).toMatchObject({ diagnostics: { kind: 'permission' } });
            expect(ask).not.toHaveBeenCalled();
            expect(onebot.call).not.toHaveBeenCalled();
            expect(log.mock.calls.map(([, value]) => JSON.parse(String(value)).event)).toEqual([
                'call_started',
                'call_finished',
            ]);
        },
    );

    it('inherits tool visibility and existing schemas without altering the original list', () => {
        expect(inputCompletionTools(computeTools('docs'))).toEqual([]);
        expect(inputCompletionTools(computeTools('read')).map((tool) => tool.name)).toEqual([
            'query_action_with_input',
        ]);
        const tools = computeTools('write');
        expect(inputCompletionTools(tools).map((tool) => tool.name)).toEqual([
            'query_action_with_input',
            'invoke_action_with_input',
        ]);
        expect(tools.some((tool) => tool.name.endsWith('_with_input'))).toBe(false);
        expect(inputCompletionTools(tools)[1].inputSchema).toEqual(
            tools.find((tool) => tool.name === 'invoke_action')?.inputSchema,
        );
    });

    it('asks before executing, never discloses existing values, and merges only validated missing fields', async () => {
        const { raw, execute } = harness();
        const first = await raw();
        expect(first.result.resultType).toBe('input_required');
        expect(execute).not.toHaveBeenCalled();
        expect(first.result.inputRequests.missing_parameters).toMatchObject({
            method: 'elicitation/create',
        });
        expect(JSON.stringify(first)).not.toContain(ORIGINAL.params.message);
        const decodedToken = Buffer.from(
            first.result.requestState.split('.')[1],
            'base64url',
        ).toString();
        expect(decodedToken).not.toContain(ORIGINAL.params.message);
        const result = await raw(ORIGINAL, answer(first.result.requestState));
        expect(result.result).toMatchObject({
            resultType: 'complete',
            structuredContent: { result: { user_id: 123, message: ORIGINAL.params.message } },
        });
        expect(execute).toHaveBeenCalledExactlyOnceWith({
            action: ORIGINAL.action,
            params: { ...ORIGINAL.params, user_id: 123 },
        });
    });

    it('executes complete arguments without requiring elicitation capability or prompting', async () => {
        const { raw, execute } = harness();
        const result = await raw({ action: 'get_msg', params: { message_id: -123 } }, {}, {});
        expect(result.result.structuredContent.result).toEqual({ message_id: -123 });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('honors permission failure before asking for input or executing', async () => {
        const { raw, execute, preflight } = harness();
        preflight.mockReturnValue(asError('write mode required', 'permission'));
        const result = await raw();
        expect(result.result.structuredContent.diagnostics.kind).toBe('permission');
        expect(result.result.inputRequests).toBeUndefined();
        expect(execute).not.toHaveBeenCalled();
    });

    it.each(['docs', 'read'] as const)(
        'enforces actual write permission in %s mode',
        async (mode) => {
            const { raw, execute } = harness({}, mode);
            const result = await raw();
            expect(result.result.structuredContent.diagnostics.kind).toBe('permission');
            expect(result.result.inputRequests).toBeUndefined();
            expect(execute).not.toHaveBeenCalled();
        },
    );

    it('does not turn a write action into a read action through the input helper', async () => {
        const { raw, execute } = harness();
        const result = await raw(ORIGINAL, {}, completeCapabilities, 'query_action_with_input');
        expect(result.result.structuredContent.diagnostics.kind).toBe('permission');
        expect(result.result.inputRequests).toBeUndefined();
        expect(execute).not.toHaveBeenCalled();
    });

    it('fails visibly when the client has no form capability', async () => {
        const { raw, execute } = harness();

        for (const capabilities of [{}, { elicitation: { url: {} } }]) {
            const result = await raw(ORIGINAL, {}, capabilities);
            expect(result.result.structuredContent.diagnostics.kind).toBe('configuration');
        }

        expect(execute).not.toHaveBeenCalled();
    });

    it.each(['decline', 'cancel'])(
        'stops on %s instead of repeatedly prompting',
        async (action) => {
            const { raw, execute } = harness();
            const first = await raw();
            const result = await raw(ORIGINAL, {
                requestState: first.result.requestState,
                inputResponses: { missing_parameters: { action } },
            });
            expect(result.result.structuredContent.diagnostics.kind).toBe('cancelled');
            expect(result.result.inputRequests).toBeUndefined();
            expect(execute).not.toHaveBeenCalled();
        },
    );

    it.each([
        { params_json: '{' },
        { params_json: '{}' },
        { params_json: '{"user_id":0}' },
        { params_json: '{"user_id":"123"}' },
        { params_json: '{"user_id":123,"message":"replacement"}' },
        { params_json: '{"user_id":123,"auto_escape":true}' },
        { params_json: '[]' },
        { params_json: '{"user_id":123}', unexpected: 'value' },
    ])('rejects invalid or extraneous answers without executing: %j', async (content) => {
        const { raw, execute } = harness();
        const first = await raw();
        const result = await raw(ORIGINAL, answer(first.result.requestState, content));
        expect(result.result.isError).toBe(true);
        expect(execute).not.toHaveBeenCalled();
    });

    it('accepts complex missing message data without guessing or normalizing it', async () => {
        const { raw, execute } = harness();
        const args = { action: 'send_private_msg', params: { user_id: 123 } };
        const message = [
            { type: 'reply', data: { id: -42 } },
            { type: 'text', data: { text: 'hello' } },
        ];
        const first = await raw(args);
        await raw(
            args,
            answer(first.result.requestState, { params_json: JSON.stringify({ message }) }),
        );
        expect(execute).toHaveBeenCalledExactlyOnceWith({
            action: args.action,
            params: { user_id: 123, message },
        });
    });

    it('rejects tampered, mismatched and state-less retries', async () => {
        const { raw, execute } = harness();
        const first = await raw();
        const tampered = await raw(ORIGINAL, answer(`${first.result.requestState}x`));
        expect(tampered.error.code).toBe(-32602);
        const changed = await raw(
            { ...ORIGINAL, params: { message: 'different message' } },
            answer(first.result.requestState),
        );
        expect(changed.result.isError).toBe(true);
        const crossed = await raw(
            ORIGINAL,
            answer(first.result.requestState),
            completeCapabilities,
            'query_action_with_input',
        );
        expect(crossed.result.isError).toBe(true);
        const noState = await raw(ORIGINAL, { inputResponses: answer('').inputResponses });
        expect(noState.result.isError).toBe(true);
        expect(execute).not.toHaveBeenCalled();
    });

    it('binds retries to the validated caller, including users sharing the same OAuth client', async () => {
        const { raw, execute } = harness();
        const first = await raw(
            ORIGINAL,
            {},
            completeCapabilities,
            'invoke_action_with_input',
            'user-a-token',
        );
        const result = await raw(
            ORIGINAL,
            answer(first.result.requestState),
            completeCapabilities,
            'invoke_action_with_input',
            'user-b-token',
        );
        expect(result.error.code).toBe(-32602);
        expect(execute).not.toHaveBeenCalled();
    });

    it('allows exactly one concurrent completion and refuses later replay', async () => {
        const { raw, execute } = harness();
        const first = await raw();
        const results = await Promise.all([
            raw(ORIGINAL, answer(first.result.requestState)),
            raw(ORIGINAL, answer(first.result.requestState)),
        ]);
        expect(execute).toHaveBeenCalledOnce();
        expect(results.filter((result) => result.result.isError)).toHaveLength(1);
        expect((await raw(ORIGINAL, answer(first.result.requestState))).result.isError).toBe(true);
        expect(execute).toHaveBeenCalledOnce();
    });

    it('expires pending input and bounds outstanding prompts without evicting live ones', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { raw, execute } = harness({ ttlSeconds: 1, maxPending: 1 });
        const first = await raw();
        expect((await raw()).result.structuredContent.diagnostics.kind).toBe('execution');
        vi.setSystemTime(Date.now() + 2_000);
        expect((await raw(ORIGINAL, answer(first.result.requestState))).error.code).toBe(-32602);
        expect((await raw()).result.resultType).toBe('input_required');
        expect(execute).not.toHaveBeenCalled();
    });

    it('does not resume an unfinished prompt after closing the runtime', async () => {
        const { raw, execute, completion } = harness();
        const first = await raw();
        completion.close();
        expect((await raw(ORIGINAL, answer(first.result.requestState))).error.code).toBe(-32602);
        expect(execute).not.toHaveBeenCalled();
    });

    it('lets a modern client drive the standard MRTR cycle', async () => {
        const { handler, execute } = harness();
        const client = new Client(
            { name: 'modern-input-test', version: '1' },
            {
                capabilities: completeCapabilities,
                versionNegotiation: { mode: { pin: '2026-07-28' } },
            },
        );
        client.setRequestHandler('elicitation/create', async () => ({
            action: 'accept',
            content: { params_json: '{"user_id":123}' },
        }));
        cleanup.push(() => client.close());
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://input.invalid/mcp'), {
                fetch: (input, init) => handler.fetch(new Request(input, init)),
            }),
        );
        const result = await client.callTool({
            name: 'invoke_action_with_input',
            arguments: ORIGINAL,
        });
        expect(result.structuredContent).toMatchObject({
            result: { user_id: 123, message: ORIGINAL.params.message },
        });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('does not execute when the caller aborts while the input form is open', async () => {
        const { handler, execute } = harness();
        const entered = Promise.withResolvers<void>();
        const inputAborted = Promise.withResolvers<void>();
        const client = new Client(
            { name: 'cancel-input-test', version: '1' },
            {
                capabilities: completeCapabilities,
                versionNegotiation: { mode: { pin: '2026-07-28' } },
            },
        );
        client.setRequestHandler('elicitation/create', async (_request, context) => {
            context.mcpReq.signal.addEventListener('abort', () => inputAborted.resolve(), {
                once: true,
            });
            entered.resolve();
            await inputAborted.promise;
            return { action: 'cancel' };
        });
        cleanup.push(() => client.close());
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://input.invalid/mcp'), {
                fetch: (input, init) => handler.fetch(new Request(input, init)),
            }),
        );
        const controller = new AbortController();
        const result = client
            .callTool(
                { name: 'invoke_action_with_input', arguments: ORIGINAL },
                { signal: controller.signal },
            )
            .catch((error: unknown) => error);
        await entered.promise;
        controller.abort(new Error('cancel test'));
        await inputAborted.promise;
        expect(await result).toBeInstanceOf(Error);
        expect(execute).not.toHaveBeenCalled();
    });

    it('integrates the production factory through the legacy elicitation shim', async () => {
        const onebot: ActionClient = {
            call: vi.fn(async () => ({ status: 'ok', retcode: 0, data: { message_id: -42 } })),
            callStream: vi.fn(),
        };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const server = createMcpServer({ mode: 'write', client: onebot });
        const client = new LegacyClient(
            { name: 'legacy-input-test', version: '1' },
            { capabilities: { elicitation: {} } },
        );
        client.setRequestHandler(ElicitRequestSchema, async () => {
            expect(onebot.call).not.toHaveBeenCalled();
            return { action: 'accept', content: { params_json: '{"user_id":123}' } };
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        cleanup.push(
            () => server.close(),
            () => client.close(),
        );
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await client.callTool({
            name: 'invoke_action_with_input',
            arguments: ORIGINAL,
        });
        expect(result.structuredContent).toMatchObject({
            result: { status: 'ok', retcode: 0, data: { message_id: -42 } },
        });
        expect(result.resultType).toBeUndefined();
        expect(onebot.call).toHaveBeenCalledExactlyOnceWith(
            'send_private_msg',
            { user_id: 123, message: ORIGINAL.params.message },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
    });

    it('keeps automatic local uploads complete without asking for runtime-owned transfer fields', async () => {
        const streamResult = {
            frame_count: 1,
            frames: [],
            terminal: { status: 'ok', retcode: 0, data: { file: 'uploaded-file' } },
        };
        const onebot: ActionClient = { call: vi.fn(), callStream: vi.fn(async () => streamResult) };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const server = createMcpServer({ mode: 'write', client: onebot });
        const client = new LegacyClient({ name: 'auto-upload-input-test', version: '1' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        cleanup.push(
            () => server.close(),
            () => client.close(),
        );
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const args = {
            action: 'upload_file_stream',
            execution: { input_file: '/fixture/media.bin' },
        };
        const original = await client.callTool({ name: 'invoke_action', arguments: args });
        const extended = await client.callTool({
            name: 'invoke_action_with_input',
            arguments: args,
        });
        expect(extended.structuredContent).toEqual(original.structuredContent);
        expect(extended.isError).toBeUndefined();
        expect(onebot.callStream).toHaveBeenCalledTimes(2);
        expect(onebot.callStream).toHaveBeenLastCalledWith(
            'upload_file_stream',
            {},
            expect.objectContaining({ inputFile: args.execution.input_file }),
        );
    });
});
