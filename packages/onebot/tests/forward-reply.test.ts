import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { Elem } from '@snowluma/proto-defs/element';
import { buildSendElems } from '@snowluma/protocol/element-builder';
import { decodeRichBody } from '@snowluma/protocol/msg-push/rich-body-decoder';
import type { ForwardNodePayload } from '@snowluma/protocol/events';
import type { OneBotInstanceContext } from '../src/instance-context';
import type { JsonObject } from '../src/types';
import { elementsToOneBotSegments } from '../src/event-converter';
import { parseMessage } from '../src/message-parser';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';
import {
    getForwardMessage,
    sendGroupForwardMessage,
    sendPrivateForwardMessage,
    uploadForwardMessage,
} from '../src/modules/message-actions';

const time = 1700000000;

function fixture(nodes: ForwardNodePayload[] = []) {
    const upload = vi.fn(async (_nodes: ForwardNodePayload[]) => 'forward-id');
    const send = vi.fn(async () => ({
        messageId: 9,
        sequence: 100,
        clientSequence: 0,
        random: 1,
        timestamp: time,
    }));
    const findEvent = vi.fn(() => null);
    const ctx = {
        uin: '10001',
        selfId: 10001,
        bridge: {
            identity: { nickname: 'SnowLuma' },
            apis: {
                forward: { upload, fetch: vi.fn(async () => nodes) },
                message: { sendGroup: send, sendPrivate: send },
            },
        },
        messageStore: { findEvent, findMedia: () => null, storeEvent: vi.fn() },
        converterCtx: {
            selfId: 10001,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: null,
            mediaSegmentSink: null,
        },
        cacheMessageMeta: vi.fn(),
        mediaStore: {},
        musicSignUrl: '',
    } as unknown as OneBotInstanceContext;
    return { ctx, upload, send, findEvent };
}

function node(data: JsonObject): JsonObject {
    return {
        type: 'node',
        data: {
            user_id: 20002,
            nickname: 'sender',
            time,
            content: [
                { type: 'reply', data },
                { type: 'text', data: { text: 'answer' } },
            ],
        },
    };
}

describe('custom replies inside merged forwards (#241)', () => {
    it.each(['group', 'private', 'upload'] as const)(
        '%s preserves custom quote text on the wire without looking up an id',
        async (scene) => {
            const { ctx, upload, findEvent } = fixture();
            const messages = [
                node({
                    id: '-123',
                    message: [{ type: 'text', data: { text: '原文\nSnowLuma 😀' } }],
                    qq: '30003',
                    time: String(time - 10),
                    seq: '42',
                }),
            ];

            if (scene === 'group') {
                await sendGroupForwardMessage(ctx, 40004, messages);
            } else if (scene === 'private') {
                await sendPrivateForwardMessage(ctx, 40004, messages);
            } else {
                await uploadForwardMessage(ctx, messages);
            }

            expect(findEvent).not.toHaveBeenCalledWith(-123);
            const elements = upload.mock.calls[0]![0][0]!.elements;
            const wire = await buildSendElems(elements);
            const src = protobuf_decode<Elem>(protobuf_encode<Elem>(wire[0]!)).srcMsg;
            expect(src).toMatchObject({ origSeqs: [42], senderUin: 30003n, time: time - 10 });
            expect(src?.elemsRaw?.map((raw) => protobuf_decode<Elem>(raw).text?.str).join('')).toBe(
                '原文\nSnowLuma 😀',
            );
            expect(wire[1]?.text?.str).toBe('answer');
            const decoded = decodeRichBody(
                {
                    richText: {
                        elems: wire.map((element) =>
                            protobuf_decode<Elem>(protobuf_encode<Elem>(element)),
                        ),
                    },
                },
                scene === 'group',
            );
            expect(decoded[0]).toMatchObject({
                type: 'reply',
                replySeq: 42,
                replySenderUin: 30003,
                replyTime: time - 10,
                replyElements: [{ type: 'text', text: '原文\nSnowLuma 😀' }],
            });
        },
    );

    it.each(
        [
            'SnowLuma',
            { type: 'text', data: { text: 'SnowLuma' } },
            [{ type: 'text', data: { text: 'SnowLuma' } }],
        ].map((message) => ({ message })),
    )('uses node metadata when only message is supplied ($message)', async ({ message }) => {
        const { ctx, upload } = fixture();
        await uploadForwardMessage(ctx, [node({ message })]);
        expect(upload.mock.calls[0]![0][0]?.elements[0]).toMatchObject({
            type: 'reply',
            replySeq: 1,
            replySenderUin: 20002,
            replyTime: time,
            replyElements: [{ type: 'text', text: 'SnowLuma' }],
        });
    });

    it('round-trips fetched quote content and metadata without a local message record', async () => {
        const { ctx, upload } = fixture([
            {
                userUin: 20002,
                nickname: 'sender',
                time,
                groupId: 40004,
                messageType: 'group',
                elements: [
                    {
                        type: 'reply',
                        replySeq: 42,
                        replySenderUin: 30003,
                        replyTime: time - 10,
                        replyElements: [{ type: 'text', text: 'quoted' }],
                    },
                    { type: 'text', text: 'answer' },
                ],
            },
        ]);
        const [fetched] = await getForwardMessage(ctx, 'original');
        expect((fetched!.message as JsonObject[])[0]?.data).toMatchObject({
            id: expect.any(String),
            message: [{ type: 'text', data: { text: 'quoted' } }],
            qq: '30003',
            time: String(time - 10),
            seq: '42',
        });
        await uploadForwardMessage(ctx, [
            {
                type: 'node',
                data: {
                    user_id: fetched!.user_id,
                    nickname: 'sender',
                    content: fetched!.message,
                },
            },
        ]);
        expect(upload.mock.calls[0]![0][0]?.elements[0]).toMatchObject({
            type: 'reply',
            replySeq: 42,
            replySenderUin: 30003,
            replyTime: time - 10,
            replyElements: [{ type: 'text', text: 'quoted' }],
        });
    });

    it('summarizes quoted media without uploading it, and works in nested forwards', async () => {
        const { ctx, upload } = fixture();
        await uploadForwardMessage(ctx, [
            {
                type: 'node',
                data: {
                    user_id: 10001,
                    content: [
                        node({
                            message: [
                                { type: 'text', data: { text: 'photo' } },
                                { type: 'image', data: { file: 'unavailable.png' } },
                                { type: 'at', data: { qq: 'all' } },
                            ],
                        }),
                    ],
                },
            },
        ]);
        expect(upload.mock.calls[0]![0][0]?.innerForward?.[0]?.elements[0]?.replyElements).toEqual([
            { type: 'text', text: 'photo[图片]@全体成员' },
        ]);
    });

    it('keeps id-only replies when QQ supplies no inline content', async () => {
        const { ctx } = fixture([
            {
                userUin: 20002,
                nickname: 'sender',
                time,
                elements: [
                    { type: 'reply', replySeq: 42 },
                    { type: 'text', text: 'answer' },
                ],
            },
        ]);
        const [fetched] = await getForwardMessage(ctx, 'original');
        expect((fetched!.message as JsonObject[])[0]).toEqual({
            type: 'reply',
            data: { id: '42' },
        });
    });

    it('accepts the full uint32 sequence range and CQ text within a quote', async () => {
        const { ctx, upload } = fixture();
        await uploadForwardMessage(ctx, [
            node({ message: 'hello[CQ:at,qq=all]', seq: 0xffffffff, time: 0 }),
        ]);
        const wire = await buildSendElems(upload.mock.calls[0]![0][0]!.elements);
        const src = protobuf_decode<Elem>(protobuf_encode<Elem>(wire[0]!)).srcMsg;
        expect(src?.origSeqs).toEqual([0xffffffff]);
        expect(src?.elemsRaw?.map((raw) => protobuf_decode<Elem>(raw).text?.str).join('')).toBe(
            'hello@全体成员',
        );
    });

    it.each([
        { message: [] },
        { message: '' },
        { message: null },
        { message: 123 },
        { message: [{ type: 'text', data: { text: {} } }] },
        { message: [{ type: 'unknown', data: {} }] },
        { message: [{ type: 'music', data: { type: 'qq', id: '1' } }] },
        { message: [{ type: 'node', data: { content: 'nested' } }] },
        { message: [{ type: 'reply', data: { message: 'nested' } }] },
        { message: 'quote', seq: 0 },
        { message: 'quote', seq: 0x100000000 },
        { message: 'quote', qq: -1 },
        { message: 'quote', qq: true },
        { message: 'quote', time: 1700000000000 },
        { message: 'quote', time: -1 },
        { message: 'quote', time: null },
        { message: 'quote', time: '' },
        { message: 'quote', time: ' ' },
        { message: 'quote', time: 1.5 },
        { message: 'quote', qq: null },
        { message: 'quote', seq: '' },
    ] satisfies JsonObject[])(
        'rejects invalid custom reply input before uploading (%j)',
        async (data) => {
            const { ctx, upload, send } = fixture();
            await expect(sendGroupForwardMessage(ctx, 40004, [node(data)])).rejects.toThrow();
            expect(upload).not.toHaveBeenCalled();
            expect(send).not.toHaveBeenCalled();
        },
    );

    it('reports malformed custom quotes as BAD_REQUEST at the action boundary', async () => {
        const { ctx, upload, send } = fixture();
        const api = new ApiHandler({
            sendGroupForwardMsg: (groupId, messages) =>
                sendGroupForwardMessage(ctx, groupId, messages),
        } as ApiActionContext);
        const result = await api.handle('send_group_forward_msg', {
            group_id: 40004,
            messages: [node({ message: 'quote', seq: 0 })],
        });
        expect(result).toMatchObject({
            status: 'failed',
            retcode: 1400,
            wording: expect.stringContaining('reply.seq'),
        });
        expect(upload).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    it('keeps ordinary reply id parsing and ordinary received reply segments unchanged', async () => {
        expect(await parseMessage([{ type: 'reply', data: { id: 42 } }], false)).toEqual([
            { type: 'reply', replySeq: 42 },
        ]);
        const { ctx } = fixture();
        expect(
            await elementsToOneBotSegments(
                ctx.converterCtx,
                [
                    {
                        type: 'reply',
                        replySeq: 42,
                        replySenderUin: 30003,
                        replyTime: time,
                        replyElements: [{ type: 'text', text: 'quoted' }],
                    },
                ],
                true,
                40004,
            ),
        ).toEqual([{ type: 'reply', data: { id: expect.any(String) } }]);
        await expect(
            parseMessage(
                [
                    { type: 'reply', data: { message: 'quote' } },
                    { type: 'text', data: { text: 'answer' } },
                ],
                false,
            ),
        ).rejects.toThrow(/forward/);
    });
});
