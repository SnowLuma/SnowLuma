import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '@modelcontextprotocol/ext-apps';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../src/server-factory.js';
import type { ActionClient } from '../src/client.js';
import type { Mode } from '../src/tools.js';
import {
    MESSAGE_APP_MIME_TYPE,
    MESSAGE_APP_URI,
    messageAppResources,
    messagePreviewTool,
    previewMessage,
    readMessageAppResource,
    supportsMessageApp,
} from '../src/message-app.js';
import { mountMessagePreview, type PreviewApp } from '../apps/preview-view.js';
import { buildMessageApp } from '../scripts/build-message-app.mjs';

const temporary: string[] = [];
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of close.splice(0).reverse()) {
        await cleanup();
    }

    await Promise.all(
        temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

const draft = { message_type: 'group', target_id: 12345, text: '你好' };

function fakeOneBot(): ActionClient {
    return {
        call: vi.fn(async () => ({ status: 'ok', retcode: 0, data: { message_id: -42 } })),
        callStream: vi.fn(async () => ({
            frame_count: 0,
            frames: [],
            terminal: { status: 'ok', retcode: 0 },
        })),
    };
}

const appCapabilities = {
    extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MESSAGE_APP_MIME_TYPE] } },
};

describe('message preview server integration', () => {
    it.each(['docs', 'read', 'write'] as Mode[])(
        'keeps legacy preview side-effect free and applies %s mode and negotiated UI capability',
        async (mode) => {
            for (const ui of [false, true]) {
                const onebot = fakeOneBot();
                const server = createMcpServer({ mode, client: onebot });
                const client = new LegacyClient(
                    { name: 'preview-legacy-test', version: '1.0.0' },
                    { capabilities: ui ? appCapabilities : {} },
                );
                const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                close.push(
                    () => server.close(),
                    () => client.close(),
                );
                await server.connect(serverTransport);
                await client.connect(clientTransport);
                const tools = await client.listTools();
                const preview = tools.tools.find((tool) => tool.name === 'preview_message');
                expect(preview).toBeDefined();
                expect(preview?._meta).toEqual(
                    ui
                        ? { ui: { resourceUri: MESSAGE_APP_URI, visibility: ['model', 'app'] } }
                        : undefined,
                );
                const resources = await client.listResources();
                expect(
                    resources.resources.some((resource) => resource.uri === MESSAGE_APP_URI),
                ).toBe(ui);
                const result = await client.callTool({ name: 'preview_message', arguments: draft });
                expect(result.isError).toBeUndefined();
                expect(result.structuredContent).toMatchObject({
                    result: { can_send: mode === 'write', draft },
                });
                expect(onebot.call).not.toHaveBeenCalled();
                expect(onebot.callStream).not.toHaveBeenCalled();

                if (mode !== 'write') {
                    expect(
                        await client.callTool({
                            name: 'invoke_action',
                            arguments: {
                                action: 'send_group_msg',
                                params: { group_id: 12345, message: '你好' },
                            },
                        }),
                    ).toMatchObject({ isError: true });
                    expect(onebot.call).not.toHaveBeenCalled();
                }
            }
        },
    );

    it('negotiates UI metadata independently for each modern request and never sends a preview', async () => {
        const onebot = fakeOneBot();
        const handler = createMcpHandler(() => createMcpServer({ mode: 'write', client: onebot }));
        close.push(() => handler.close());

        const request = async (method: string, params: Record<string, unknown>, ui: boolean) => {
            const response = await handler.fetch(
                new Request('http://mcp.invalid/mcp', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'Mcp-Method': method,
                        'Mcp-Protocol-Version': '2026-07-28',
                        ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method,
                        params: {
                            ...params,
                            _meta: {
                                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                                'io.modelcontextprotocol/clientCapabilities': ui
                                    ? appCapabilities
                                    : {},
                                'io.modelcontextprotocol/clientInfo': {
                                    name: 'preview-modern-test',
                                    version: '1.0.0',
                                },
                            },
                        },
                    }),
                }),
            );
            expect(response.status).toBe(200);
            return await response.json();
        };

        for (const ui of [true, false, true]) {
            const tools = await request('tools/list', {}, ui);
            expect(
                tools.result.tools.find((tool: { name: string }) => tool.name === 'preview_message')
                    ._meta,
            ).toEqual(
                ui
                    ? { ui: { resourceUri: MESSAGE_APP_URI, visibility: ['model', 'app'] } }
                    : undefined,
            );
            const resources = await request('resources/list', {}, ui);
            expect(
                resources.result.resources.some(
                    (resource: { uri: string }) => resource.uri === MESSAGE_APP_URI,
                ),
            ).toBe(ui);
            expect(resources.result.cacheScope).toBe('private');
            const preview = await request(
                'tools/call',
                { name: 'preview_message', arguments: draft },
                ui,
            );
            expect(preview.result.structuredContent).toMatchObject({
                result: { can_send: true, draft },
            });
        }

        expect(onebot.call).not.toHaveBeenCalled();
        expect(onebot.callStream).not.toHaveBeenCalled();
    });
});

describe('message preview tool', () => {
    it('negotiates optional HTML support and retains text-only tool discovery', () => {
        for (const capabilities of [
            undefined,
            {},
            { extensions: {} },
            { extensions: { 'io.modelcontextprotocol/ui': {} } },
        ]) {
            expect(supportsMessageApp(capabilities)).toBe(false);
        }

        expect(
            supportsMessageApp({
                extensions: {
                    'io.modelcontextprotocol/ui': { mimeTypes: [MESSAGE_APP_MIME_TYPE] },
                },
            }),
        ).toBe(true);
        expect(messagePreviewTool(false)._meta).toBeUndefined();
        expect(messagePreviewTool(true)._meta).toEqual({
            ui: { resourceUri: MESSAGE_APP_URI, visibility: ['model', 'app'] },
        });
        expect(messageAppResources(false)).toEqual([]);
        expect(messageAppResources(true)).toEqual([
            expect.objectContaining({ uri: MESSAGE_APP_URI, mimeType: MESSAGE_APP_MIME_TYPE }),
        ]);
    });

    it('returns a literal text draft and preserves negative quoted-message identifiers without executing', () => {
        const result = previewMessage(
            { ...draft, text: '[CQ:at,qq=all]<script>bad()</script>', reply_to: -42 },
            true,
        );
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent.result).toEqual({
            draft: { ...draft, text: '[CQ:at,qq=all]<script>bad()</script>', reply_to: -42 },
            can_send: true,
            notice: '此为待发送草稿，尚未发送。',
            invocation: {
                name: 'invoke_action',
                arguments: {
                    action: 'send_group_msg',
                    params: {
                        group_id: 12345,
                        message: [
                            { type: 'reply', data: { id: '-42' } },
                            {
                                type: 'text',
                                data: { text: '[CQ:at,qq=all]<script>bad()</script>' },
                            },
                        ],
                    },
                },
            },
        });
        expect(result.content).toEqual([
            { type: 'text', text: JSON.stringify(result.structuredContent.result, null, 2) },
        ]);
        expect(
            previewMessage({ ...draft, message_type: 'private' }, false).structuredContent.result,
        ).toMatchObject({
            can_send: false,
            invocation: { arguments: { action: 'send_private_msg', params: { user_id: 12345 } } },
        });
    });

    it.each([
        { ...draft, message_type: 'other' },
        { ...draft, target_id: 0 },
        { ...draft, target_id: '12345' },
        { ...draft, target_id: Number.MAX_SAFE_INTEGER + 1 },
        { ...draft, text: '  \n' },
        { ...draft, reply_to: 0 },
        { ...draft, reply_to: 2147483648 },
        { ...draft, reply_to: -2147483649 },
        { ...draft, message: [] },
    ])('rejects an invalid draft without discarding fields: %j', (args) => {
        expect(previewMessage(args, true)).toMatchObject({
            isError: true,
            structuredContent: { diagnostics: { kind: 'invalid_arguments' } },
        });
    });

    it('does not hide a missing packaged panel', async () => {
        await expect(readMessageAppResource('unrelated://resource')).resolves.toBeUndefined();
        // Tests run from source; only an actual build supplies the sibling HTML.
        await expect(readMessageAppResource(MESSAGE_APP_URI)).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('builds a self-contained panel with exact CSP hashes and no external assets', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'snowluma-message-app-'));
        temporary.push(directory);
        const path = await buildMessageApp(directory);
        const html = await readFile(path, 'utf8');
        const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
        const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
        expect(script).toBeTruthy();
        expect(style).toBeTruthy();
        expect(html).toContain(
            `script-src 'sha256-${createHash('sha256').update(script!).digest('base64')}'`,
        );
        expect(html).toContain(
            `style-src 'sha256-${createHash('sha256').update(style!).digest('base64')}'`,
        );
        expect(html).toContain("connect-src 'none'");
        expect(html).not.toMatch(/<(?:script|img|iframe)\b[^>]*\bsrc\s*=/i);
        expect(html).not.toContain('unsafe-inline');
        expect(html).not.toContain('unsafe-eval');
        expect(html).toContain('ui/initialize');
        expect(html).toContain('发送这条消息');
    });
});

class TestElement {
    textContent = '';
    disabled = true;
    private readonly listeners = new Map<string, () => void | Promise<void>>();

    set innerHTML(_value: string) {
        throw new Error('Untrusted markup must never be rendered');
    }

    addEventListener(type: string, callback: () => void | Promise<void>): void {
        this.listeners.set(type, callback);
    }

    async click(): Promise<void> {
        await this.listeners.get('click')?.();
    }
}

async function panel(options: { writable?: boolean; hostTools?: boolean } = {}) {
    const elements = Object.fromEntries(
        ['target', 'message', 'reply', 'status', 'send', 'cancel'].map((id) => [
            id,
            new TestElement(),
        ]),
    );
    const app: PreviewApp = {
        ontoolresult: undefined,
        ontoolcancelled: undefined,
        onerror: undefined,
        onclose: undefined,
        connect: vi.fn(async () => {}),
        getHostCapabilities: () => (options.hostTools === false ? {} : { serverTools: {} }),
        callServerTool: vi.fn(async () => ({
            content: [],
            structuredContent: {
                result: { status: 'ok', retcode: 0, data: { message_id: -42 } },
                diagnostics: { outcome: 'success' },
            },
        })),
    };
    mountMessagePreview(app, {
        getElementById: (id: string) => elements[id],
    } as unknown as Document);
    await Promise.resolve();
    app.ontoolresult?.(previewMessage({ ...draft, reply_to: -42 }, options.writable !== false));
    return { elements, app };
}

describe('message preview interaction', () => {
    it('uses the official app handshake, tool-result notification and host-proxied send', async () => {
        const app = new App(
            { name: 'preview-test', version: '1.0.0' },
            {},
            { autoResize: false, strict: true },
        );
        const bridge = new AppBridge(
            null,
            { name: 'isolated-host', version: '1.0.0' },
            { serverTools: {} },
        );
        bridge.oncalltool = vi.fn(async () => ({
            content: [],
            structuredContent: { result: { status: 'ok', retcode: 0, data: { message_id: -99 } } },
        }));
        const [appTransport, hostTransport] = InMemoryTransport.createLinkedPair();
        close.push(
            () => app.close(),
            () => bridge.close(),
        );
        await bridge.connect(hostTransport);
        const originalConnect = app.connect.bind(app);
        let connected: Promise<void> | undefined;
        vi.spyOn(app, 'connect').mockImplementation(() => {
            connected = originalConnect(appTransport);
            return connected;
        });
        const elements = Object.fromEntries(
            ['target', 'message', 'reply', 'status', 'send', 'cancel'].map((id) => [
                id,
                new TestElement(),
            ]),
        );
        mountMessagePreview(app, {
            getElementById: (id: string) => elements[id],
        } as unknown as Document);
        await connected;
        await bridge.sendToolInput({ arguments: draft });
        await bridge.sendToolResult(previewMessage(draft, true));
        await new Promise((resolve) => setImmediate(resolve));
        expect(bridge.oncalltool).not.toHaveBeenCalled();
        expect(elements.target.textContent).toBe('群聊 · 12345');
        await elements.send.click();
        expect(bridge.oncalltool).toHaveBeenCalledTimes(1);
        expect(elements.status.textContent).toBe('服务端已接受消息。消息编号：-99');
    });

    it('renders untrusted text without markup and never sends on load or repeated results', async () => {
        const { app, elements } = await panel();
        app.ontoolresult?.(
            previewMessage({ ...draft, text: '<img src=x onerror=alert(1)>' }, true),
        );
        expect(elements.message.textContent).toBe('<img src=x onerror=alert(1)>');
        expect(app.callServerTool).not.toHaveBeenCalled();
        expect(elements.send.disabled).toBe(false);
    });

    it('sends once only on click through the existing invocation and displays a signed result', async () => {
        const { app, elements } = await panel();
        await Promise.all([elements.send.click(), elements.send.click()]);
        app.ontoolresult?.(previewMessage(draft, true));
        await elements.send.click();
        expect(app.callServerTool).toHaveBeenCalledExactlyOnceWith({
            name: 'invoke_action',
            arguments: {
                action: 'send_group_msg',
                params: {
                    group_id: 12345,
                    message: [
                        { type: 'reply', data: { id: '-42' } },
                        { type: 'text', data: { text: '你好' } },
                    ],
                },
            },
        });
        expect(elements.status.textContent).toBe('服务端已接受消息。消息编号：-42');
        expect(elements.send.disabled).toBe(true);
    });

    it.each([{ writable: false }, { hostTools: false }])(
        'keeps unsupported or read-only panels non-sending: %j',
        async (options) => {
            const { app, elements } = await panel(options);
            await elements.send.click();
            expect(elements.send.disabled).toBe(true);
            expect(app.callServerTool).not.toHaveBeenCalled();
        },
    );

    it('cancels drafts locally and does not re-arm after another notification', async () => {
        const { app, elements } = await panel();
        await elements.cancel.click();
        app.ontoolresult?.(previewMessage(draft, true));
        await elements.send.click();
        expect(app.callServerTool).not.toHaveBeenCalled();
        expect(elements.status.textContent).toContain('未发送消息');
    });

    it('does not retry or claim success after a transport failure', async () => {
        const { app, elements } = await panel();
        vi.mocked(app.callServerTool).mockRejectedValueOnce(new Error('connection lost'));
        await elements.send.click();
        await elements.send.click();
        expect(app.callServerTool).toHaveBeenCalledTimes(1);
        expect(elements.status.textContent).toContain('尚未确认');
        expect(elements.send.disabled).toBe(true);
    });

    it('recognizes business failures even when MCP isError is false', async () => {
        const { app, elements } = await panel();
        vi.mocked(app.callServerTool).mockResolvedValueOnce({
            content: [],
            structuredContent: {
                result: { status: 'failed', retcode: 1400 },
                diagnostics: { outcome: 'failed', message: '<b>拒绝</b>' },
            },
        });
        await elements.send.click();
        expect(elements.status.textContent).toContain('发送失败：<b>拒绝</b>');
        expect(elements.send.disabled).toBe(true);
    });

    it('stops sending when the host disconnects', async () => {
        const { app, elements } = await panel();
        app.onclose?.();
        await elements.send.click();
        expect(app.callServerTool).not.toHaveBeenCalled();
        expect(elements.status.textContent).toContain('连接已断开');
    });
});
