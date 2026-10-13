import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync, gzipSync, inflateSync } from 'node:zlib';
import type { MsgInfo } from '@snowluma/proto-defs/element';
import type {
    LongMsgResult,
    RecvLongMsgResp,
    SendLongMsgReq,
    SendLongMsgResp,
} from '@snowluma/proto-defs/longmsg';
import type { PushMsgBody } from '@snowluma/proto-defs/message';
import { buildApiContext, type OneBotInstanceContext } from '@snowluma/onebot/instance-context';
import { buildSendElems } from '@snowluma/protocol/element-builder';
import type { MessageElement } from '@snowluma/protocol/events';
import { runNtv2Upload } from '@snowluma/protocol/highway/pipeline';
import { loadBinarySource } from '@snowluma/protocol/highway/utils';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { ForwardApi } from '../../src/bridge/apis/forward';
import type { BridgeContext } from '../../src/bridge/bridge-context';
import { mockBridge } from './_helpers';

// Keep the image uploader, element builder and Proton codecs real. Only the
// network boundaries are faked, including a source URL that needs an rkey.
vi.mock('@snowluma/protocol/highway/pipeline', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@snowluma/protocol/highway/pipeline')>()),
    runNtv2Upload: vi.fn(),
}));
vi.mock('@snowluma/protocol/highway/utils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@snowluma/protocol/highway/utils')>()),
    loadBinarySource: vi.fn(async () => {
        throw new Error('source image URL requires an rkey');
    }),
}));

const md5Hex = 'ab'.repeat(16);
const sha1Hex = 'cd'.repeat(20);
const sourceInfo: MsgInfo = {
    msgInfoBody: [
        {
            index: {
                fileUuid: 'source-group-image',
                info: {
                    fileHash: md5Hex,
                    fileSha1: sha1Hex,
                    fileSize: 1234,
                    fileName: 'image.png',
                    width: 32,
                    height: 24,
                    type: { type: 1, picFormat: 1001 },
                },
            },
            picture: {
                domain: 'multimedia.nt.qq.com.cn',
                urlPath: '/download?appid=1407&fileid=source-group-image',
            },
        },
    ],
};

function packetResult(responseData: Uint8Array) {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(responseData),
    };
}

function setup(id: string) {
    const sourceBody: PushMsgBody = {
        responseHead: {
            fromUin: 20002,
            fromUid: 'sender-uid',
            grp: { groupUin: 12345, memberCard: 'alice' },
        },
        contentHead: { msgType: 82, sequence: 10, timestamp: 1700000000 },
        body: {
            richText: {
                elems: [
                    { text: { str: 'picture' } },
                    {
                        commonElem: {
                            serviceType: 48,
                            businessType: 20,
                            pbElem: protobuf_encode<MsgInfo>(sourceInfo),
                        },
                    },
                ],
            },
        },
    };
    const sentLongMessages: SendLongMsgReq[] = [];
    const bridge = mockBridge({
        resolveUserUid: vi.fn(async () => 'self-uid'),
        sendRawPacket: vi.fn(async (command: string, bytes: Uint8Array) => {
            if (command.endsWith('SsoRecvLongMsg')) {
                return packetResult(
                    protobuf_encode<RecvLongMsgResp>({
                        result: {
                            payload: gzipSync(
                                protobuf_encode<LongMsgResult>({
                                    action: [
                                        {
                                            actionCommand: 'MultiMsg',
                                            actionData: { msgBody: [sourceBody] },
                                        },
                                    ],
                                }),
                            ),
                        },
                    }),
                );
            }

            expect(command).toMatch(/SsoSendLongMsg$/);
            sentLongMessages.push(protobuf_decode<SendLongMsgReq>(bytes));
            return packetResult(
                protobuf_encode<SendLongMsgResp>({ result: { resId: `new-${id}` } }),
            );
        }),
    });
    const forward = new ForwardApi(bridge as unknown as BridgeContext);
    const sendPrivate = vi.fn(async (_userId: number, elements: MessageElement[]) => {
        const [card] = await buildSendElems(elements);
        expect(card?.richMsg?.serviceId).toBe(35);
        const xml = inflateSync(card!.richMsg!.template1!.subarray(1)).toString();
        expect(xml).toContain(`m_resid="new-${id}"`);
        expect(xml).toContain('alice: picture [图片]');
        return { messageId: 1, sequence: 2, clientSequence: 3, random: 4, timestamp: 1700000001 };
    });
    const ctx = {
        selfId: 10001,
        bridge: { identity: { nickname: 'SnowLuma' }, apis: { forward, message: { sendPrivate } } },
        messageStore: {
            findEvent: () => ({ message: [{ type: 'forward', data: { id } }] }),
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
    return { api: buildApiContext(ctx), forward, sendPrivate, sentLongMessages, bridge };
}

describe('single merged-forward media (#437)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(runNtv2Upload).mockImplementation(async (params) => ({
            msgInfo: {
                msgInfoBody: [
                    {
                        index: {
                            fileUuid: 'target-private-image',
                            info: params.uploadInfo[0]!.fileInfo,
                        },
                    },
                ],
            },
        }));
    });

    it('reuploads a decoded group image for self-chat without downloading its unsigned source URL', async () => {
        const { api, forward, sentLongMessages, bridge } = setup('image-to-self');
        await expect(api.forwardSingleMsg(77, { userId: 10001 })).resolves.toHaveProperty(
            'messageId',
        );

        expect(loadBinarySource).not.toHaveBeenCalled();
        expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);
        expect(runNtv2Upload).toHaveBeenCalledOnce();
        expect(vi.mocked(runNtv2Upload).mock.calls[0]![0]).toMatchObject({
            isGroup: false,
            targetIdOrUid: 'self-uid',
            oidbCmd: 0x11c5,
            uploadInfo: [
                {
                    fileInfo: {
                        fileHash: md5Hex,
                        fileSha1: sha1Hex,
                        width: 32,
                        height: 24,
                        fileSize: 1234,
                    },
                },
            ],
            uploads: [{ bytes: new Uint8Array(0) }],
        });
        expect(sentLongMessages).toHaveLength(1);
        expect(sentLongMessages[0]!.info?.type).toBe(1);
        const body = protobuf_decode<LongMsgResult>(
            gunzipSync(sentLongMessages[0]!.info!.payload!),
        );
        const elems = body.action![0]!.actionData!.msgBody![0]!.body!.richText!.elems!;
        expect(elems.find((e) => e.commonElem)?.commonElem?.businessType).toBe(10);
        const media = protobuf_decode<MsgInfo>(
            elems.find((e) => e.commonElem)!.commonElem!.pbElem!,
        );
        expect(media.msgInfoBody?.[0]?.index?.fileUuid).toBe('target-private-image');
        expect(elems.find((e) => e.notOnlineImage)?.notOnlineImage?.picMd5).toEqual(
            Buffer.from(md5Hex, 'hex'),
        );
        expect(
            (await forward.fetch('image-to-self'))[0]!.elements[1]!.noByteFallback,
        ).toBeUndefined();
    });

    it('does not send a card or upload a long message when target image upload fails', async () => {
        vi.mocked(runNtv2Upload).mockRejectedValueOnce(
            new Error('image fast-upload not available (server requires bytes)'),
        );
        const { api, sendPrivate, sentLongMessages } = setup('image-upload-failure');
        await expect(api.forwardSingleMsg(77, { userId: 10001 })).rejects.toThrow(
            'image fast-upload not available',
        );
        expect(sendPrivate).not.toHaveBeenCalled();
        expect(sentLongMessages).toHaveLength(0);
        expect(loadBinarySource).not.toHaveBeenCalled();
    });
});
