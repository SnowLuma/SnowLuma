import { describe, expect, it, vi } from 'vitest';
import { deflateSync, gzipSync } from 'zlib';
import { buildApiContext, type OneBotInstanceContext } from '@snowluma/onebot/instance-context';
import type { Elem } from '@snowluma/proto-defs/element';
import type { LongMsgResult, RecvLongMsgReq, RecvLongMsgResp } from '@snowluma/proto-defs/longmsg';
import type { PushMsgBody } from '@snowluma/proto-defs/message';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { ForwardApi } from '../../src/bridge/apis/forward';
import type { BridgeContext } from '../../src/bridge/bridge-context';
import { mockBridge } from './_helpers';

function forwardCard(format: 'xml' | 'lightApp', resId: string, key?: string): Elem {
    const content =
        format === 'xml'
            ? `<msg serviceID="35" m_resid="${resId}"${key ? ` m_fileName="${key}"` : ''} />`
            : JSON.stringify({
                  app: 'com.tencent.multimsg',
                  meta: { detail: { resid: resId, uniseq: key } },
              });
    const data = Buffer.concat([Buffer.from([1]), deflateSync(Buffer.from(content))]);
    return format === 'xml'
        ? { richMsg: { serviceId: 35, template1: data } }
        : { lightApp: { data } };
}

function message(...elems: Elem[]): PushMsgBody {
    return {
        responseHead: {
            fromUin: 20002,
            fromUid: 'sender-uid',
            grp: { groupUin: 12345, memberCard: 'alice' },
        },
        contentHead: { msgType: 82, sequence: 10, timestamp: 1700000000 },
        body: { richText: { elems } },
    };
}

function setup(downloads: Map<string, LongMsgResult>) {
    const requested: string[] = [];
    const bridge = mockBridge({
        sendRawPacket: vi.fn(async (command: string, bytes: Uint8Array) => {
            expect(command).toBe('trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg');
            const resId = protobuf_decode<RecvLongMsgReq>(bytes).info!.resId!;
            requested.push(resId);
            const data = downloads.get(resId);
            return {
                success: true,
                gotResponse: true,
                errorCode: 0,
                errorMessage: '',
                responseData: Buffer.from(
                    protobuf_encode<RecvLongMsgResp>({
                        result: {
                            resId,
                            payload: data
                                ? gzipSync(protobuf_encode<LongMsgResult>(data))
                                : undefined,
                        },
                    }),
                ),
            };
        }),
    });
    const forward = new ForwardApi(bridge as unknown as BridgeContext);
    const ctx = {
        selfId: 10001,
        bridge: { apis: { forward } },
        converterCtx: {
            selfId: 10001,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: null,
            mediaSegmentSink: null,
        },
    } as unknown as OneBotInstanceContext;
    return { api: buildApiContext(ctx), requested };
}

describe('get_forward_msg / nested downloads (#529)', () => {
    it.each(['xml', 'lightApp'] as const)(
        'resolves siblings and three levels of %s forwards from one outer payload',
        async (format) => {
            const outer = `nested-fetch-${format}-outer`;
            const inner = `nested-fetch-${format}-inner`;
            const sibling = `nested-fetch-${format}-sibling`;
            const leaf = `nested-fetch-${format}-leaf`;
            const { api, requested } = setup(
                new Map([
                    [
                        outer,
                        {
                            action: [
                                {
                                    actionCommand: 'MultiMsg',
                                    actionData: {
                                        msgBody: [
                                            message(forwardCard(format, inner, 'inner-key')),
                                            message(forwardCard(format, sibling, 'sibling-key')),
                                        ],
                                    },
                                },
                                {
                                    actionCommand: 'leaf-key',
                                    actionData: {
                                        msgBody: [
                                            message(
                                                { text: { str: 'deepest content' } },
                                                {
                                                    customFace: {
                                                        md5: Buffer.alloc(16, 0xab),
                                                        origUrl: 'https://example.com/forward.png',
                                                        width: 32,
                                                        height: 24,
                                                    },
                                                },
                                            ),
                                        ],
                                    },
                                },
                                {
                                    actionCommand: 'sibling-key',
                                    actionData: {
                                        msgBody: [message({ text: { str: 'sibling content' } })],
                                    },
                                },
                                {
                                    actionCommand: 'inner-key',
                                    actionData: {
                                        msgBody: [message(forwardCard(format, leaf, 'leaf-key'))],
                                    },
                                },
                            ],
                        },
                    ],
                ]),
            );

            const parent = await api.getForwardMsg(outer);
            expect(parent.map((node) => node.message)).toEqual([
                [{ type: 'forward', data: { id: inner } }],
                [{ type: 'forward', data: { id: sibling } }],
            ]);
            const middle = await api.getForwardMsg(inner);
            expect(middle[0]!.message).toEqual([{ type: 'forward', data: { id: leaf } }]);
            expect((await api.getForwardMsg(leaf))[0]).toMatchObject({
                sender: { user_id: 20002, nickname: 'alice' },
                time: 1700000000,
                message: [
                    { type: 'text', data: { text: 'deepest content' } },
                    { type: 'image', data: { url: 'https://example.com/forward.png' } },
                ],
            });
            expect((await api.getForwardMsg(sibling))[0]!.message).toEqual([
                { type: 'text', data: { text: 'sibling content' } },
            ]);
            expect(requested).toEqual([outer]);
        },
    );

    it.each([undefined, 'unmatched-key'])(
        'downloads by resId when the XML filename is %s and preserves empty-payload errors',
        async (key) => {
            const outer = `nested-fetch-fallback-${key}-outer`;
            const inner = `nested-fetch-fallback-${key}-inner`;
            const empty = `nested-fetch-fallback-${key}-empty`;
            const { api, requested } = setup(
                new Map([
                    [
                        outer,
                        {
                            action: [
                                {
                                    actionCommand: 'MultiMsg',
                                    actionData: {
                                        msgBody: [
                                            message(forwardCard('xml', inner, key)),
                                            message(forwardCard('xml', empty, key)),
                                        ],
                                    },
                                },
                                {
                                    actionCommand: 'unrelated-key',
                                    actionData: {
                                        msgBody: [message({ text: { str: 'unrelated content' } })],
                                    },
                                },
                            ],
                        },
                    ],
                    [
                        inner,
                        {
                            action: [
                                {
                                    actionCommand: 'MultiMsg',
                                    actionData: {
                                        msgBody: [message({ text: { str: 'downloaded content' } })],
                                    },
                                },
                            ],
                        },
                    ],
                ]),
            );

            await api.getForwardMsg(outer);
            expect((await api.getForwardMsg(inner))[0]!.message).toEqual([
                { type: 'text', data: { text: 'downloaded content' } },
            ]);
            await expect(api.getForwardMsg(empty)).rejects.toThrow(
                'download forward message payload is empty',
            );
            expect(requested).toEqual([outer, inner, empty]);
        },
    );
});
