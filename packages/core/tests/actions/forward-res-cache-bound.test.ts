// `forwardResCache` grows on every resolved merged forward, so it must stay
// bounded. Inner layers (piggyback bodies carried by an outer fetch) are NOT
// independently downloadable — reading one after eviction hits the wire and
// comes back with an empty payload. So inner entries must live and die with
// their owner, and the bound must be counted in outer entries only.
// Regression for the review on #546.

import { describe, expect, it, vi } from 'vitest';
import { deflateSync, gzipSync } from 'zlib';
import { buildApiContext, type OneBotInstanceContext } from '@snowluma/onebot/instance-context';
import type { Elem } from '@snowluma/proto-defs/element';
import type { LongMsgResult, RecvLongMsgReq, RecvLongMsgResp } from '@snowluma/proto-defs/longmsg';
import type { PushMsgBody } from '@snowluma/proto-defs/message';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { ForwardApi, resetForwardResCache } from '../../src/bridge/apis/forward';
import type { BridgeContext } from '../../src/bridge/bridge-context';
import { mockBridge } from './_helpers';

function forwardCard(resId: string, key?: string): Elem {
    const content = `<msg serviceID="35" m_resid="${resId}"${key ? ` m_fileName="${key}"` : ''} />`;
    const data = Buffer.concat([Buffer.from([1]), deflateSync(Buffer.from(content))]);
    return { richMsg: { serviceId: 35, template1: data } };
}

function message(...elems: Elem[]): PushMsgBody {
    return {
        responseHead: { fromUin: 20002, fromUid: 'sender-uid', grp: { groupUin: 12345 } },
        contentHead: { msgType: 82, sequence: 10, timestamp: 1700000000 },
        body: { richText: { elems } },
    };
}

function textMessage(text: string): PushMsgBody {
    return message({ text: { str: text } });
}

function setup(downloads: Map<string, LongMsgResult>) {
    const requested: string[] = [];
    const bridge = mockBridge({
        sendRawPacket: vi.fn(async (_command: string, bytes: Uint8Array) => {
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

/** Outer payload with one inner forward carried in the piggyback set. */
function nestedOuter(inner: string, uuid: string): LongMsgResult {
    return {
        action: [
            {
                actionCommand: 'MultiMsg',
                actionData: { msgBody: [message(forwardCard(inner, uuid))] },
            },
            { actionCommand: uuid, actionData: { msgBody: [textMessage('inner-body')] } },
        ],
    };
}

describe('forward res cache eviction (#546 review)', () => {
    it('keeps an inner layer readable while its owner stays cached', async () => {
        resetForwardResCache();
        const downloads = new Map<string, LongMsgResult>([
            ['evict-outer', nestedOuter('evict-inner', 'uuid-evict')],
        ]);

        // Fill 500 unrelated outer entries around it.
        for (let i = 0; i < 500; i++) {
            downloads.set(`filler-${i}`, { action: [{ actionCommand: 'MultiMsg', actionData: { msgBody: [textMessage('x')] } }] });
        }

        const { api, requested } = setup(downloads);

        await api.getForwardMsg('evict-outer');

        for (let i = 0; i < 500; i++) {
            await api.getForwardMsg(`filler-${i}`);
        }

        requested.length = 0;
        const inner = await api.getForwardMsg('evict-inner');

        expect(inner).toBeTruthy();
        // Served from cache — an inner resId is not independently downloadable.
        expect(requested).toEqual([]);
    });

    it('evicts an inner layer together with its owner, never on its own', async () => {
        resetForwardResCache();
        const downloads = new Map<string, LongMsgResult>([
            ['owner-out', nestedOuter('owner-in', 'uuid-owner')],
        ]);

        for (let i = 0; i < 600; i++) {
            downloads.set(`fill-${i}`, { action: [{ actionCommand: 'MultiMsg', actionData: { msgBody: [textMessage('x')] } }] });
        }

        const { api, requested } = setup(downloads);

        await api.getForwardMsg('owner-out');

        for (let i = 0; i < 600; i++) {
            await api.getForwardMsg(`fill-${i}`);
        }

        // The owner aged out (>512 outer entries since), so the inner entry
        // must be gone too — reading it goes to the wire, where an inner
        // resId yields an empty payload.
        requested.length = 0;
        await expect(api.getForwardMsg('owner-in')).rejects.toThrow();
        expect(requested).toEqual(['owner-in']);
    });

    it('does not count many inner layers of one owner toward the bound', async () => {
        resetForwardResCache();
        const downloads = new Map<string, LongMsgResult>();
        const outerAction: NonNullable<LongMsgResult['action']> = [
            {
                actionCommand: 'MultiMsg',
                actionData: {
                    msgBody: Array.from({ length: 40 }, (_, i) => message(forwardCard(`many-in-${i}`, `uuid-many-${i}`))),
                },
            },
        ];

        for (let i = 0; i < 40; i++) {
            outerAction.push({ actionCommand: `uuid-many-${i}`, actionData: { msgBody: [textMessage(`inner-${i}`)] } });
        }

        downloads.set('many-out', { action: outerAction });

        for (let i = 0; i < 510; i++) {
            downloads.set(`tail-${i}`, { action: [{ actionCommand: 'MultiMsg', actionData: { msgBody: [textMessage('x')] } }] });
        }

        const { api, requested } = setup(downloads);

        await api.getForwardMsg('many-out');

        for (let i = 0; i < 510; i++) {
            await api.getForwardMsg(`tail-${i}`);
        }

        // 1 owner + 40 inner + 510 fillers = 551 entries, but only 511 are
        // counted — the owner (and therefore every inner layer) survives.
        requested.length = 0;
        for (let i = 0; i < 40; i += 13) {
            await expect(api.getForwardMsg(`many-in-${i}`)).resolves.toBeTruthy();
        }

        expect(requested).toEqual([]);
    });
});
