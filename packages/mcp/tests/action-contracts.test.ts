import { describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { collectActionDocs } from '@snowluma/onebot/action-docs';
import { ApiHandler, type ApiActionContext } from '@snowluma/onebot/api-handler';
import type { JsonObject, JsonValue } from '@snowluma/onebot/types';
import { ACTIONS } from '../src/generated/catalog';
import { callTool } from '../src/tools';

const validator = new AjvJsonSchemaValidator();

function resultValidator(name: string) {
    const action = ACTIONS.find((entry) => entry.name === name);

    if (!action?.returnsSchema) {
        throw new Error(`missing result schema: ${name}`);
    }

    return validator.getValidator(action.returnsSchema);
}

function matchesResult(name: string, data: unknown): void {
    const result = resultValidator(name)(data);
    expect(result.valid, `${name}: ${result.errorMessage}`).toBe(true);
}

/** Unexpected dependencies fail rather than contacting an account or a network. */
function context(values: Record<string, unknown> = {}): ApiActionContext {
    return new Proxy(values, {
        get(target, key) {
            if (typeof key === 'string' && Object.hasOwn(target, key)) {
                return target[key];
            }

            throw new Error(`unstubbed action context: ${String(key)}`);
        },
    }) as unknown as ApiActionContext;
}

describe('bundled action contracts', () => {
    it('matches the owning specs, without relying on a second hand-authored registry', () => {
        expect(ACTIONS).toEqual(JSON.parse(JSON.stringify(collectActionDocs())));
    });

    it.each(ACTIONS)('$name publishes compilable schemas and schema-valid examples', (action) => {
        expect(() => resultValidator(action.name)).not.toThrow();
        const validateInput = validator.getValidator(action.inputSchema);
        expect(action.examples?.length).toBeGreaterThan(0);

        for (const example of action.examples ?? []) {
            const result = validateInput(example.params);
            expect(result.valid, `${action.name}: ${result.errorMessage}`).toBe(true);
        }
    });

    it('exposes full contracts through get_action and aliases without executing anything', async () => {
        const client = { call: vi.fn(), callStream: vi.fn() };

        for (const action of ACTIONS) {
            for (const name of [action.name, ...action.aliases]) {
                const result = await callTool('get_action', { name }, { mode: 'docs', client });
                expect(result.structuredContent.result).toEqual(action);
                expect(result.content[0]).toEqual({
                    type: 'text',
                    text: JSON.stringify(action, null, 2),
                });
            }
        }

        expect(client.call).not.toHaveBeenCalled();
        expect(client.callStream).not.toHaveBeenCalled();
    });

    it.each(['list_actions', 'search_actions'])('keeps %s compact', async (name) => {
        const result = await callTool(name, { query: 'send_group_msg' }, { mode: 'docs' });
        const block = result.content[0];
        expect(block.type).toBe('text');

        if (block.type !== 'text') {
            throw new Error('expected text result');
        }

        const payload = JSON.parse(block.text);
        expect(payload.actions.length).toBeGreaterThan(0);

        for (const action of payload.actions) {
            expect(action).not.toHaveProperty('examples');
            expect(action).not.toHaveProperty('returnsSchema');
        }
    });
});

describe('result schemas against actual OneBot handlers', () => {
    it('preserves signed message IDs and documents the upload-only sentinel separately', async () => {
        const api = new ApiHandler(
            context({
                sendGroupMessage: async () => ({ messageId: -123 }),
                sendForwardMsg: async () => ({ forwardId: 'example-forward' }),
            }),
        );
        const send = await api.handle('send_group_msg', { group_id: 20001, message: 'hello' });
        expect(send).toEqual({ status: 'ok', retcode: 0, data: { message_id: -123 } });
        matchesResult('send_group_msg', send.data);
        expect(resultValidator('send_group_msg')({ message_id: 0 }).valid).toBe(false);

        for (const name of ['upload_forward_msg', 'upload_foward_msg']) {
            const uploaded = await api.handle(name, {
                group_id: 20001,
                messages: [
                    {
                        type: 'node',
                        data: { user_id: 10001, nickname: 'example', content: 'hello' },
                    },
                ],
            });
            expect(uploaded.status).toBe('ok');
            expect(uploaded.data).toMatchObject({ message_id: 0, res_id: 'example-forward' });
            matchesResult(name, uploaded.data);

            if (name === 'upload_forward_msg') {
                expect(uploaded.data).toHaveProperty('group_id', 20001);
            } else {
                expect(uploaded.data).not.toHaveProperty('group_id');
            }
        }
    });

    it('distinguishes null, empty objects, and failed unsupported calls', async () => {
        const api = new ApiHandler(
            context({
                bridge: {
                    apis: {
                        friend: { setRemark: async () => {} },
                        profile: { setInputStatus: async () => {} },
                    },
                },
            }),
        );
        const empty = await api.handle('set_friend_remark', { user_id: 10001, remark: 'example' });
        expect(empty.data).toBeNull();
        matchesResult('set_friend_remark', empty.data);
        expect(resultValidator('set_friend_remark')({}).valid).toBe(false);
        const object = await api.handle('set_input_status', { user_id: 10001 });
        expect(object.data).toEqual({});
        matchesResult('set_input_status', object.data);
        expect(resultValidator('set_input_status')(null).valid).toBe(false);

        for (const name of ['set_restart', 'create_collection', '.get_word_slices']) {
            const failure = await api.handle(name, {});
            expect(failure.status).toBe('failed');
            expect(resultValidator(name)(failure.data).valid).toBe(false);
        }
    });

    it('documents actual media string sizes and optional converted record fields', async () => {
        const media = {
            file: 'https://example.com/media',
            url: 'https://example.com/media',
            file_size: '42',
            file_name: 'voice.amr',
        };
        const api = new ApiHandler(
            context({
                getImageInfo: async () => media,
                getRecordInfo: async () => media,
                bridge: {
                    apis: {
                        extras: { convertRecord: async () => ({ base64: 'aGVsbG8=', size: 5 }) },
                    },
                },
            }),
        );

        for (const name of ['get_image', 'get_file', 'get_record']) {
            const result = await api.handle(name, { file: 'cached-media' });
            expect(result.status).toBe('ok');
            matchesResult(name, result.data);
            expect(resultValidator(name)({ ...media, file_size: 42 }).valid).toBe(false);
        }

        const converted = await api.handle('get_record', {
            file: 'cached-media',
            out_format: 'mp3',
        });
        expect(converted.data).toEqual({ ...media, out_format: 'mp3', base64: 'aGVsbG8=' });
        matchesResult('get_record', converted.data);
    });

    it('describes get_msg data without the event envelope for both conversation types', async () => {
        for (const messageType of ['group', 'private']) {
            const event: JsonObject = {
                post_type: 'message',
                self_id: 10002,
                message_type: messageType,
                message_id: -123,
                user_id: 10001,
                time: 1700000000,
                message: [{ type: 'text', data: { text: 'hello' } }],
                raw_message: 'hello',
                ...(messageType === 'group' ? { group_id: 20001 } : { target_id: 10002 }),
            };
            const api = new ApiHandler(
                context({
                    getMessage: async () => event,
                    refreshMessageMedia: async () => {},
                }),
            );
            const result = await api.handle('get_msg', { message_id: -123 });
            expect(result.status).toBe('ok');
            expect(result.data).toMatchObject({ real_id: -123, message_id: -123 });
            expect(result.data).not.toHaveProperty('post_type');
            expect(result.data).not.toHaveProperty('self_id');
            matchesResult('get_msg', result.data);
        }
    });

    it('describes successful stream frame data, not MCP aggregate results or failed frames', async () => {
        const api = new ApiHandler(context());
        const frames: JsonValue[] = [];
        const response = await api.handle(
            'test_download_stream',
            { error: false },
            {
                send: async (frame) => {
                    frames.push(frame);
                },
            },
        );
        expect(frames).toHaveLength(10);
        expect(response.status).toBe('ok');

        for (const frame of [...frames, response.data]) {
            matchesResult('test_download_stream', frame);
        }

        expect(
            resultValidator('test_download_stream')({ frame_count: 11, frames, terminal: response })
                .valid,
        ).toBe(false);
        expect(
            resultValidator('test_download_stream')({ type: 'error', data_type: 'error' }).valid,
        ).toBe(false);
        const failure = await api.handle('test_download_stream', { error: true });
        expect(failure.status).toBe('failed');
    });
});
