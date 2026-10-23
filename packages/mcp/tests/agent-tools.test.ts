import { describe, expect, it, vi } from 'vitest';
import { callTool, computeTools } from '../src/tools';
import { ACTIONS } from '../src/generated/catalog';
import type { ActionClient, OneBotEnvelope } from '../src/client';
import { ActionCallError } from '../src/results';

const docs = { mode: 'docs' as const };

function client(
    reply: OneBotEnvelope = { status: 'ok', retcode: 0, data: { message_id: -123 } },
): ActionClient {
    return {
        call: vi.fn(async () => reply),
        callStream: vi.fn(async () => ({ frame_count: 1, frames: [], terminal: reply })),
    };
}

function text(result: Awaited<ReturnType<typeof callTool>>) {
    expect(result.content[0].type).toBe('text');
    return result.content[0].type === 'text' ? result.content[0].text : '';
}

describe('additive structured results', () => {
    it.each(['list_actions', 'list_categories', 'get_action', 'search_actions'])(
        'keeps the original text payload for %s',
        async (name) => {
            const result = await callTool(name, { name: 'get_status', query: 'get_status' }, docs);
            expect(result.structuredContent.result).toEqual(JSON.parse(text(result)));
            expect(result.structuredContent.diagnostics).toEqual({ outcome: 'success' });
            expect(
                computeTools('docs').find((tool) => tool.name === name)?.outputSchema,
            ).toBeDefined();
        },
    );

    it.each([
        { status: 'ok', retcode: 0, data: { message_id: -123 } },
        { status: 'failed', retcode: 1404, wording: 'not found' },
        { status: 'async', retcode: 1 },
    ])('preserves the OneBot envelope and isError contract ($status)', async (reply) => {
        const result = await callTool(
            'invoke_action',
            { action: 'send_group_msg' },
            { mode: 'write', client: client(reply) },
        );
        expect(text(result)).toBe(JSON.stringify(reply, null, 2));
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent.result).toEqual(reply);
        expect(result.structuredContent.diagnostics.outcome).toBe(
            reply.status === 'ok' ? 'success' : reply.status === 'failed' ? 'failed' : 'unknown',
        );
    });

    it('reports permission failures without contacting OneBot', async () => {
        const onebot = client();
        const result = await callTool(
            'query_action',
            { action: 'send_group_msg' },
            { mode: 'read', client: onebot },
        );
        expect(result.isError).toBe(true);
        expect(result.structuredContent.diagnostics).toMatchObject({
            outcome: 'failed',
            kind: 'permission',
        });
        expect(onebot.call).not.toHaveBeenCalled();
    });

    it.each(['timeout', 'cancelled', 'authentication', 'transport', 'invalid_response'] as const)(
        'makes %s observable without claiming a write was rolled back',
        async (kind) => {
            const onebot = client();
            onebot.call = vi.fn(async () => {
                throw new ActionCallError('request failed', kind);
            });
            const result = await callTool(
                'invoke_action',
                { action: 'send_group_msg' },
                { mode: 'write', client: onebot },
            );
            expect(result.isError).toBe(true);
            expect(result.structuredContent.diagnostics).toMatchObject({
                outcome: 'unknown',
                kind,
            });
            expect(result.structuredContent.diagnostics.next_step).toContain('不代表撤销');
            expect(onebot.call).toHaveBeenCalledTimes(1);
        },
    );

    it('does not report an incomplete response as successful', async () => {
        const onebot = client();
        onebot.call = async () => JSON.parse('{"data":null}');
        const result = await callTool(
            'query_action',
            { action: 'get_status' },
            { mode: 'read', client: onebot },
        );
        expect(result.structuredContent.diagnostics).toMatchObject({
            outcome: 'unknown',
            kind: 'invalid_response',
        });
        expect(text(result)).toBe('{\n  "data": null\n}');
    });

    it('keeps malformed peer fields in the original payload without breaking the diagnostics schema', async () => {
        const onebot = client();
        onebot.call = async () =>
            JSON.parse('{"status":"failed","retcode":1400,"wording":{"unexpected":true}}');
        const result = await callTool(
            'query_action',
            { action: 'get_status' },
            { mode: 'read', client: onebot },
        );
        expect(result.structuredContent.diagnostics.message).toBe('retcode=1400');
        expect(JSON.parse(text(result)).wording).toEqual({ unexpected: true });
    });
});

describe('optional discovery controls', () => {
    it('keeps legacy matching, ordering and response fields by default', async () => {
        const result = await callTool('search_actions', { query: '群 禁言' }, docs);
        expect(JSON.parse(text(result))).toEqual({ count: 0, actions: [] });
        const all = JSON.parse(text(await callTool('list_actions', {}, docs)));
        expect(Object.keys(all)).toEqual(['count', 'actions']);
        expect(all.actions.map((action: { name: string }) => action.name)).toEqual(
            ACTIONS.map((action) => action.name),
        );
    });

    it.each([
        ['群 禁言', 'set_group_ban'],
        ['历史消息', 'get_group_msg_history'],
        ['私聊 history', 'get_friend_msg_history'],
        ['group mute', 'set_group_ban'],
    ])('finds %s with optional keyword matching', async (query, expected) => {
        const data = JSON.parse(
            text(await callTool('search_actions', { query, match: 'keywords' }, docs)),
        );
        expect(data.actions.map((action: { name: string }) => action.name)).toContain(expected);
    });

    it('ranks an exact alias first and combines filters', async () => {
        const exact = JSON.parse(
            text(
                await callTool('search_actions', { query: 'nc_get_rkey', match: 'keywords' }, docs),
            ),
        );
        expect(exact.actions[0].name).toBe('get_rkey');
        const filtered = JSON.parse(
            text(
                await callTool(
                    'search_actions',
                    {
                        query: '群',
                        match: 'keywords',
                        category: '群管理',
                        read_only: false,
                        stream: false,
                    },
                    docs,
                ),
            ),
        );
        expect(filtered.count).toBeGreaterThan(0);
        expect(
            filtered.actions.every(
                (action: { category: string; readOnly: boolean; stream: boolean }) =>
                    action.category === '群管理' && !action.readOnly && !action.stream,
            ),
        ).toBe(true);
    });

    it('paginates deterministically with explicit totals and termination', async () => {
        const names: string[] = [];
        let offset: number | null = 0;

        while (offset !== null) {
            const data = JSON.parse(
                text(await callTool('list_actions', { limit: 37, offset }, docs)),
            );
            expect(data.total).toBe(ACTIONS.length);
            expect(data.count).toBe(data.actions.length);
            names.push(...data.actions.map((action: { name: string }) => action.name));
            offset = data.next_offset;
        }

        expect(names).toEqual(ACTIONS.map((action) => action.name));
        const beyond = JSON.parse(text(await callTool('list_actions', { offset: 9999 }, docs)));
        expect(beyond).toEqual({ count: 0, actions: [], total: ACTIONS.length, next_offset: null });
    });

    it.each([
        { limit: 0 },
        { limit: 201 },
        { offset: -1 },
        { offset: 0.5 },
        { stream: 'true' },
        { read_only: 1 },
        { match: 'typo' },
    ])('rejects invalid new options (%j)', async (options) => {
        const result = await callTool('search_actions', { query: '', ...options }, docs);
        expect(result.isError).toBe(true);
        expect(result.structuredContent.diagnostics.kind).toBe('invalid_arguments');
    });
});

describe('runtime overview and caller cancellation', () => {
    it('does not contact OneBot for a local overview, even if a client exists in docs mode', async () => {
        const onebot = client();
        const result = await callTool('get_runtime_info', {}, { ...docs, client: onebot });
        expect(result.structuredContent.result).toMatchObject({
            mode: 'docs',
            execution_enabled: false,
            write_enabled: false,
            transport: null,
            connection_checked: false,
            catalog: { action_count: ACTIONS.length, server_support: 'unknown' },
        });
        expect(onebot.call).not.toHaveBeenCalled();
        const denied = await callTool(
            'get_runtime_info',
            { check_connection: true },
            { ...docs, client: onebot },
        );
        expect(denied.isError).toBe(true);
        expect(onebot.call).not.toHaveBeenCalled();
    });

    it('only performs the three explicit read-only checks and preserves individual failures', async () => {
        const onebot = client();
        const controller = new AbortController();
        onebot.call = vi.fn(async (action, _params, options) => {
            expect(options?.signal).toBe(controller.signal);
            return action === 'get_status'
                ? { status: 'failed', retcode: 1401, wording: 'unauthorized' }
                : { status: 'ok', retcode: 0, data: { action } };
        });
        const result = await callTool(
            'get_runtime_info',
            { check_connection: true },
            { mode: 'read', client: onebot, signal: controller.signal },
        );
        expect(vi.mocked(onebot.call).mock.calls.map(([action]) => action)).toEqual([
            'get_login_info',
            'get_status',
            'get_version_info',
        ]);
        expect(result.structuredContent.diagnostics.outcome).toBe('failed');
        expect(result.structuredContent.result).toMatchObject({
            checks: {
                get_status: { result: { retcode: 1401 }, diagnostics: { outcome: 'failed' } },
            },
        });
    });

    it('forwards ordinary request cancellation and does not start pre-cancelled calls', async () => {
        const controller = new AbortController();
        const onebot = client();
        await callTool(
            'query_action',
            { action: 'get_status' },
            { mode: 'read', client: onebot, signal: controller.signal },
        );
        expect(onebot.call).toHaveBeenCalledWith('get_status', {}, { signal: controller.signal });
        controller.abort();
        const result = await callTool(
            'query_action',
            { action: 'get_status' },
            { mode: 'read', client: onebot, signal: controller.signal },
        );
        expect(onebot.call).toHaveBeenCalledTimes(1);
        expect(result.structuredContent.diagnostics.kind).toBe('cancelled');
    });
});
