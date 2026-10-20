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

function setup(downloads: Map<string, LongMsgResult>, selfUin = '10001') {
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
    bridge.identity.uin = selfUin;
    const forward = new ForwardApi(bridge as unknown as BridgeContext);
    const ctx = {
        selfId: Number(selfUin),
        bridge: { apis: { forward } },
        converterCtx: {
            selfId: Number(selfUin),
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: null,
            mediaSegmentSink: null,
        },
    } as unknown as OneBotInstanceContext;
    return { api: buildApiContext(ctx), requested, bridge, forward };
}

function plainResult(text: string): LongMsgResult {
    return {
        action: [
            {
                actionCommand: 'MultiMsg',
                actionData: { msgBody: [message({ text: { str: text } })] },
            },
        ],
    };
}

function nestedResult(inner: string, key: string, body?: PushMsgBody): LongMsgResult {
    return {
        action: [
            {
                actionCommand: 'MultiMsg',
                actionData: { msgBody: [message(forwardCard('xml', inner, key))] },
            },
            {
                actionCommand: key,
                actionData: { msgBody: [body ?? message({ text: { str: 'inner content' } })] },
            },
        ],
    };
}

async function fillCache(
    api: ReturnType<typeof setup>['api'],
    downloads: Map<string, LongMsgResult>,
    prefix: string,
    count: number,
): Promise<void> {
    for (let index = 0; index < count; index++) {
        const id = `${prefix}-${index}`;
        downloads.set(id, plainResult(id));
        await api.getForwardMsg(id);
    }
}

describe('get_forward_msg / cache lifetime', () => {
    it('bounds cached results while refreshing recently read results', async () => {
        const downloads = new Map([
            ['cache-cold', plainResult('cold')],
            ['cache-hot', plainResult('hot')],
        ]);
        const { api, requested } = setup(downloads);
        await api.getForwardMsg('cache-cold');
        await api.getForwardMsg('cache-hot');
        await fillCache(api, downloads, 'cache-pressure', 510);
        await api.getForwardMsg('cache-hot');
        await fillCache(api, downloads, 'cache-overflow', 1);
        requested.length = 0;
        await api.getForwardMsg('cache-hot');
        await api.getForwardMsg('cache-cold');
        expect(requested).toEqual(['cache-cold']);
    });

    it('isolates cached content between bridge accounts', async () => {
        const first = setup(new Map([['same-resource', plainResult('account one')]]));
        const second = setup(new Map([['same-resource', plainResult('account two')]]), '10002');
        await first.api.getForwardMsg('same-resource');
        expect((await second.api.getForwardMsg('same-resource'))[0]?.message).toEqual([
            { type: 'text', data: { text: 'account two' } },
        ]);
        expect(second.requested).toEqual(['same-resource']);
    });

    it('keeps nested results with a hot outer result under cache pressure', async () => {
        const downloads = new Map([['hot-outer', nestedResult('hot-inner', 'hot-inner-key')]]);
        const { api, requested } = setup(downloads);
        await api.getForwardMsg('hot-outer');
        await fillCache(api, downloads, 'nested-pressure', 511);
        await api.getForwardMsg('hot-inner');
        await fillCache(api, downloads, 'nested-overflow', 1);
        requested.length = 0;
        expect((await api.getForwardMsg('hot-outer'))[0]?.message).toEqual([
            { type: 'forward', data: { id: 'hot-inner' } },
        ]);
        expect((await api.getForwardMsg('hot-inner'))[0]?.message).toEqual([
            { type: 'text', data: { text: 'inner content' } },
        ]);
        expect(requested).toEqual([]);
    });

    it('keeps an inner result attached to its outer result after sender enrichment', async () => {
        const nameless = message({ text: { str: 'unnamed sender' } });
        nameless.responseHead!.grp!.memberCard = '';
        const downloads = new Map([
            ['enrich-outer', nestedResult('enrich-inner', 'enrich-key', nameless)],
        ]);
        const { api, requested, bridge } = setup(downloads);
        bridge.apis.contacts.fetchGroupMemberList.mockResolvedValue([
            { uin: 20002, nickname: 'resolved nickname', card: 'resolved card' },
        ]);
        await api.getForwardMsg('enrich-outer');
        await fillCache(api, downloads, 'enrich-pressure', 511);
        requested.length = 0;
        expect((await api.getForwardMsg('enrich-inner'))[0]).toMatchObject({
            sender: { nickname: 'resolved card' },
        });
        expect(bridge.apis.contacts.fetchGroupMemberList).toHaveBeenCalledOnce();
        await api.getForwardMsg('enrich-outer');
        await api.getForwardMsg('enrich-inner');
        expect(bridge.apis.contacts.fetchGroupMemberList).toHaveBeenCalledOnce();
        expect(requested).toEqual([]);
    });

    it('retains a shared inner result while another containing outer result remains cached', async () => {
        const downloads = new Map([
            ['shared-outer-a', nestedResult('shared-inner', 'shared-key-a')],
            ['shared-outer-b', nestedResult('shared-inner', 'shared-key-b')],
        ]);
        const { api, requested } = setup(downloads);
        await api.getForwardMsg('shared-outer-a');
        await api.getForwardMsg('shared-outer-b');
        await fillCache(api, downloads, 'shared-pressure', 510);
        await api.getForwardMsg('shared-outer-a');
        await fillCache(api, downloads, 'shared-overflow', 1);
        requested.length = 0;
        expect((await api.getForwardMsg('shared-inner'))[0]?.message).toEqual([
            { type: 'text', data: { text: 'inner content' } },
        ]);
        expect(requested).toEqual([]);
    });

    it('restores all nested results when an evicted outer result is downloaded again', async () => {
        const downloads = new Map([
            ['restore-outer', nestedResult('restore-inner', 'restore-key')],
        ]);
        const { api, requested } = setup(downloads);
        await api.getForwardMsg('restore-outer');
        await api.getForwardMsg('restore-inner');
        await fillCache(api, downloads, 'restore-pressure', 512);
        requested.length = 0;
        await api.getForwardMsg('restore-outer');
        expect((await api.getForwardMsg('restore-inner'))[0]?.message).toEqual([
            { type: 'text', data: { text: 'inner content' } },
        ]);
        expect(requested).toEqual(['restore-outer']);
    });

    it('does not resurrect evicted nested results when enrichment finishes late', async () => {
        const nameless = message({ text: { str: 'late sender' } });
        nameless.responseHead!.grp!.memberCard = '';
        const downloads = new Map([
            ['late-outer', nestedResult('late-inner', 'late-key', nameless)],
        ]);
        const { api, requested, bridge } = setup(downloads);
        const members = [{ uin: 20002, nickname: 'late name', card: '' }];
        let finishEnrichment!: () => void;
        const enrichment = new Promise<typeof members>((resolve) => {
            finishEnrichment = () => resolve(members);
        });
        bridge.apis.contacts.fetchGroupMemberList.mockReturnValueOnce(enrichment);
        await api.getForwardMsg('late-outer');
        const pending = api.getForwardMsg('late-inner');
        await vi.waitFor(() =>
            expect(bridge.apis.contacts.fetchGroupMemberList).toHaveBeenCalledOnce(),
        );
        await fillCache(api, downloads, 'late-pressure', 512);
        finishEnrichment();
        expect((await pending)[0]).toMatchObject({ sender: { nickname: 'late name' } });
        requested.length = 0;
        await expect(api.getForwardMsg('late-inner')).rejects.toThrow('payload is empty');
        await api.getForwardMsg('late-outer');
        expect((await api.getForwardMsg('late-inner'))[0]?.message).toEqual([
            { type: 'text', data: { text: 'late sender' } },
        ]);
        expect(requested).toEqual(['late-inner', 'late-outer']);
    });
});

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
