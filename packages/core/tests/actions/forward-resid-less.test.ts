import { describe, expect, it, vi } from 'vitest';
import { deflateSync, gunzipSync, gzipSync } from 'node:zlib';
import type { Elem } from '@snowluma/proto-defs/element';
import type {
    LongMsgResult,
    RecvLongMsgReq,
    RecvLongMsgResp,
    SendLongMsgReq,
    SendLongMsgResp,
} from '@snowluma/proto-defs/longmsg';
import type { PushMsgBody } from '@snowluma/proto-defs/message';
import { buildApiContext, type OneBotInstanceContext } from '@snowluma/onebot/instance-context';
import type { MessageElement } from '@snowluma/protocol/events';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { ForwardApi } from '../../src/bridge/apis/forward';
import type { BridgeContext } from '../../src/bridge/bridge-context';
import { mockBridge } from './_helpers';

const OUTER_RES_ID = 'outer-resid';
const INNER_UUID = 'C125CE25-AE7E-4E1A-ABDC-9750918162EB';
const INNER_FILE_NAME = `MultiMsg_${INNER_UUID}`;

function packetResult(responseData: Uint8Array) {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(responseData),
    };
}

function residLessForwardCard(): Elem {
    const xml =
        `<msg serviceID="35" templateID="1" action="viewMultiMsg" ` +
        `m_fileName="${INNER_FILE_NAME}" tSum="2" flag="3" />`;
    const data = Buffer.concat([Buffer.from([1]), deflateSync(Buffer.from(xml))]);
    return { richMsg: { serviceId: 35, template1: data } };
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

function outerResult(innerActionCommand?: string): LongMsgResult {
    return {
        action: [
            {
                actionCommand: 'MultiMsg',
                actionData: { msgBody: [message(residLessForwardCard())] },
            },
            ...(innerActionCommand
                ? [
                      {
                          actionCommand: innerActionCommand,
                          actionData: {
                              msgBody: [
                                  message({ text: { str: 'inner one' } }),
                                  message({ text: { str: 'inner two' } }),
                              ],
                          },
                      },
                  ]
                : []),
        ],
    };
}

function setup(innerActionCommand?: string) {
    const requested: string[] = [];
    const uploads: SendLongMsgReq[] = [];
    const sendRawPacket = vi.fn(async (command: string, bytes: Uint8Array) => {
        if (command.endsWith('SsoRecvLongMsg')) {
            const resId = protobuf_decode<RecvLongMsgReq>(bytes).info!.resId!;
            requested.push(resId);
            return packetResult(
                protobuf_encode<RecvLongMsgResp>({
                    result: {
                        resId,
                        payload:
                            resId === OUTER_RES_ID
                                ? gzipSync(
                                      protobuf_encode<LongMsgResult>(
                                          outerResult(innerActionCommand),
                                      ),
                                  )
                                : undefined,
                    },
                }),
            );
        }

        expect(command).toMatch(/SsoSendLongMsg$/);
        const upload = protobuf_decode<SendLongMsgReq>(bytes);
        uploads.push(upload);
        return packetResult(
            protobuf_encode<SendLongMsgResp>({ result: { resId: `rebuilt-${uploads.length}` } }),
        );
    });
    const bridge = mockBridge({ sendRawPacket });
    const forward = new ForwardApi(bridge as unknown as BridgeContext);
    const sendGroup = vi.fn(async (_groupId: number, _elements: MessageElement[]) => ({
        messageId: 1,
        sequence: 2,
        clientSequence: 3,
        random: 4,
        timestamp: 1700000001,
    }));
    const ctx = {
        selfId: 10001,
        bridge: {
            identity: { nickname: 'SnowLuma' },
            apis: { forward, message: { sendGroup } },
        },
        messageStore: {
            findEvent: () => ({
                message: [{ type: 'forward', data: { id: OUTER_RES_ID } }],
            }),
            storeEvent: vi.fn(),
        },
        converterCtx: {
            selfId: 10001,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: null,
            mediaSegmentSink: null,
        },
        cacheMessageMeta: vi.fn(),
        dispatchEvent: vi.fn(),
    } as unknown as OneBotInstanceContext;

    return { api: buildApiContext(ctx), requested, uploads, sendGroup };
}

describe('resid-less nested forwards (#589)', () => {
    it.each([INNER_UUID, INNER_FILE_NAME])(
        'resolves an outer piggyback keyed by %s without another download',
        async (innerActionCommand) => {
            const { api, requested } = setup(innerActionCommand);
            const outer = await api.getForwardMsg(OUTER_RES_ID);
            expect(outer[0]?.message).toEqual([{ type: 'forward', data: { id: INNER_FILE_NAME } }]);

            const inner = await api.getForwardMsg(INNER_FILE_NAME);
            expect(inner.map((node) => node.message)).toEqual([
                [{ type: 'text', data: { text: 'inner one' } }],
                [{ type: 'text', data: { text: 'inner two' } }],
            ]);
            expect(requested).toEqual([OUTER_RES_ID]);
        },
    );

    it('rebuilds both layers before sending to another group', async () => {
        const { api, requested, uploads, sendGroup } = setup(INNER_UUID);
        await expect(api.forwardSingleMsg(77, { groupId: 65432 })).resolves.toHaveProperty(
            'messageId',
        );

        expect(requested).toEqual([OUTER_RES_ID]);
        expect(uploads).toHaveLength(2);
        const outerBytes = gunzipSync(Buffer.from(uploads[1]!.info!.payload!));
        const outer = protobuf_decode<LongMsgResult>(outerBytes);
        expect(outer.action).toHaveLength(2);
        expect(outerBytes.toString()).not.toContain(INNER_FILE_NAME);
        expect(sendGroup).toHaveBeenCalledOnce();
        expect(sendGroup.mock.calls[0]![1]).toEqual([
            expect.objectContaining({ type: 'forward', resId: 'rebuilt-2' }),
        ]);
    });

    it('fails before upload or send when the inner piggyback is unavailable', async () => {
        const { api, requested, uploads, sendGroup } = setup();
        await expect(api.forwardSingleMsg(77, { groupId: 65432 })).rejects.toThrow(
            'download forward message payload is empty',
        );

        expect(requested).toEqual([OUTER_RES_ID, INNER_FILE_NAME]);
        expect(uploads).toHaveLength(0);
        expect(sendGroup).not.toHaveBeenCalled();
    });
});
