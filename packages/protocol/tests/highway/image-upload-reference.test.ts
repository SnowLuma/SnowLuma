import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    EncodableMediaMsgInfo,
    HighwayMsgInfoBody,
    NTV2UploadRichMediaResp,
} from '@snowluma/proto-defs/highway';
import type { BridgeContext } from '../../src/bridge-context';
import type { MessageElement } from '../../src/events';
import { uploadImageMsgInfo } from '../../src/highway/image-upload';

const webp = 'base64://UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';

function bridge(body: HighwayMsgInfoBody): BridgeContext {
    return {
        identity: { uin: '10001' },
        sendRawPacket: vi.fn(async () => ({
            success: true,
            gotResponse: true,
            errorCode: 0,
            responseData: protobuf_encode<OidbBase<NTV2UploadRichMediaResp>>({
                body: { upload: { msgInfo: { msgInfoBody: [body] } } },
            }),
        })),
    } as unknown as BridgeContext;
}

describe('uploaded image download references (#659)', () => {
    it.each([false, true])(
        'retains the returned host, original parameters and WebP filename (group=%s)',
        async (isGroup) => {
            const picture = {
                domain: 'image.example',
                urlPath: '/download?fileid=server-resource',
                ext: { originalParameter: '&spec=0', thumbParameter: '&spec=small' },
            };
            const element: MessageElement = { type: 'image', url: webp };
            const encoded = await uploadImageMsgInfo(
                bridge({ index: { fileUuid: 'resource' }, picture }),
                isGroup,
                isGroup ? 20002 : 'u_peer',
                element,
            );
            expect(element).toMatchObject({
                imageUrl: 'https://image.example/download?fileid=server-resource&spec=0',
                picFormat: 1002,
                width: 1,
                height: 1,
            });
            expect(element.fileName).toBe(`${element.md5Hex}.webp`);
            expect(element.fileId).toBe(element.fileName);
            expect(
                protobuf_decode<EncodableMediaMsgInfo>(encoded).msgInfoBody?.[0]?.picture,
            ).toMatchObject(picture);
        },
    );

    it.each([false, true])(
        'uses an encoded upload resource id when the server omits the URL (group=%s)',
        async (isGroup) => {
            const element: MessageElement = { type: 'image', url: webp };
            await uploadImageMsgInfo(
                bridge({ index: { fileUuid: 'resource/+=' } }),
                isGroup,
                isGroup ? 20002 : 'u_peer',
                element,
            );
            expect(element.imageUrl).toBe(
                `https://multimedia.nt.qq.com.cn/download?appid=${isGroup ? 1407 : 1406}&fileid=resource%2F%2B%3D`,
            );
        },
    );

    it('uses the standard image host when a wire response omits the domain', async () => {
        const element: MessageElement = { type: 'image', url: webp };
        await uploadImageMsgInfo(
            bridge({ picture: { urlPath: '/download?fileid=resource' } }),
            false,
            'u_peer',
            element,
        );
        expect(element.imageUrl).toBe('https://multimedia.nt.qq.com.cn/download?fileid=resource');
    });

    it('rejects an unusable upload receipt before publishing incomplete send metadata', async () => {
        const element: MessageElement = { type: 'image', url: webp };
        await expect(uploadImageMsgInfo(bridge({}), false, 'u_peer', element)).rejects.toThrow(
            'missing a download reference',
        );
        expect(element).toEqual({ type: 'image', url: webp });
    });
});
