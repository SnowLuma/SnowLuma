import { afterEach, describe, expect, it, vi } from 'vitest';
import { getQzoneFeedDetail, getQzoneShareArk } from '../../src/web/qzone-public';
import { RequestUtil, getBknFromCookie } from '../../src/web/request-util';

const cookies = { p_skey: 'fixture', uin: 'o20002' };
// Synthetic post: author 10001, Unix time 1700000000, sequence word 1.
const tid = '1127000000f1536501000000';
const ugcId = 'CLcCEJFOGIDiz6oGIgAqADIBMEIYMTEyNzAwMDAwMGYxNTM2NTAxMDAwMDAw';
const feed = {
    cell_common: { domain_type: 1, union_id: { feed_id: tid, ugc_id: ugcId }, operate_mask: 0 },
    cell_summary: { summary: 'Fixture post' },
    cell_pic: { pics: [{ url: 'https://example.com/one.png' }, { future_image: true }] },
    cell_video: { opaque_video: 'preserved' },
    cell_comment: { comments: [{ id: '9007199254740993', unknown: true }] },
    cell_operation: {
        share_outside: {
            share_access_resource: { busi_id: 'qzone_feed', resource_id: 'resource' },
        },
    },
    cell_feed_transfer: 'original-transfer',
    cell_future: { nested: [null, '18446744073709551615', { preserved: true }] },
};
const detail = {
    feed: { feed },
    attach_info: 'opaque-comment-continuation',
    contribute_bar: null,
    future_detail_field: { preserved: true },
};

afterEach(() => vi.restoreAllMocks());

describe('Qzone feed detail by tid', () => {
    it.each([tid, tid.toUpperCase()])(
        'requests the personal-space detail with the encoded identity (%s)',
        async (input) => {
            const request = vi
                .spyOn(RequestUtil, 'HttpGetJson')
                .mockResolvedValue({ retcode: 0, data: detail });
            const result = await getQzoneFeedDetail(cookies, input);

            expect(result).toEqual({ ...detail, feed });
            expect(result.feed).toBe(feed);
            expect(request).toHaveBeenCalledExactlyOnceWith(
                `https://h5.qzone.qq.com/http2rpc/gotrpc/v1/trpc.qzone.feeds_reader.FeedsReader/GetFeedDetail?g_tk=${getBknFromCookie(cookies)}`,
                'POST',
                {
                    union_id: { feed_id: tid, ugc_id: ugcId, adv_id: null },
                    feed_action_domain_type: 1,
                    from_page: 1,
                },
                expect.objectContaining({
                    Cookie: 'p_skey=fixture; uin=o20002',
                    'Content-Type': 'application/json',
                    'x-oidb': JSON.stringify({
                        uint32_command: '0x97b1',
                        uint32_service_type: '1',
                    }),
                }),
            );
        },
    );

    it('keeps the author and time unsigned and emits the explicit empty identity fields', async () => {
        const highTid = 'ffffffffffffffff01000000';
        const request = vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({
            retcode: 0,
            data: { feed: { feed: { cell_common: { union_id: { feed_id: highTid } } } } },
        });

        await getQzoneFeedDetail(cookies, highTid);
        const body = request.mock.calls[0]![2] as { union_id: { ugc_id: string } };
        // Independent wire vector: app 311; two uint32-max values encoded as
        // positive int64; present empty strings in fields 4 and 5; field 8 tid.
        expect(Buffer.from(body.union_id.ugc_id, 'base64').toString('hex')).toBe(
            '08b70210ffffffff0f18ffffffff0f22002a003201304218' +
                '666666666666666666666666666666663031303030303030',
        );
    });

    it.each([undefined, null, ''])(
        'preserves an empty or absent upstream comment cursor (%s)',
        async (attach_info) => {
            const request = vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({
                retcode: 0,
                data: { ...detail, attach_info },
            });

            expect((await getQzoneFeedDetail(cookies, tid)).attach_info).toBe(attach_info ?? null);
            expect(request).toHaveBeenCalledOnce();
        },
    );

    it.each(['', 'T1', 'g'.repeat(24), 'a'.repeat(23), 'a'.repeat(25), `${tid}\n`, ` ${tid}`])(
        'rejects unsupported or malformed post IDs before requesting (%j)',
        async (input) => {
            const request = vi.spyOn(RequestUtil, 'HttpGetJson');

            await expect(getQzoneFeedDetail(cookies, input)).rejects.toThrow('24 位十六进制');
            expect(request).not.toHaveBeenCalled();
        },
    );

    it.each([
        {},
        { feed: null },
        { feed: [] },
        { feed: { feed: [] } },
        { feed: { feed: {} } },
        { feed: { feed: { cell_common: { union_id: { feed_id: 'other' } } } } },
        { ...detail, attach_info: {} },
    ])('rejects incomplete, mismatched or malformed details (%#)', async (data) => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetJson')
            .mockResolvedValue({ retcode: 0, data });

        await expect(getQzoneFeedDetail(cookies, tid)).rejects.toThrow('GetFeedDetail');
        expect(request).toHaveBeenCalledOnce();
    });

    it('propagates access and transport failures without a second request', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetJson')
            .mockResolvedValueOnce({ retcode: 10023, message: '无权限访问' })
            .mockRejectedValueOnce(new Error('network down'));

        await expect(getQzoneFeedDetail(cookies, tid)).rejects.toThrow('10023 无权限访问');
        expect(request).toHaveBeenCalledTimes(1);
        await expect(getQzoneFeedDetail(cookies, tid)).rejects.toThrow('network down');
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('passes the returned feed straight to card generation without rebuilding sharing data', async () => {
        const ark = '{ "app": "com.tencent.tuwen.lua", "fixture": true }';
        const request = vi
            .spyOn(RequestUtil, 'HttpGetJson')
            .mockResolvedValueOnce({ retcode: 0, data: detail })
            .mockResolvedValueOnce({ retcode: 0, data: { template_data: ark } });
        const result = await getQzoneFeedDetail(cookies, tid);

        await expect(getQzoneShareArk(cookies, result.feed)).resolves.toEqual({
            ark,
            requires_confirmation: false,
            notice: null,
        });
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('/trpc.qq.share.Service/CreateShare?g_tk='),
            'POST',
            {
                info: {
                    busi_id: 'qzone_feed',
                    resource_id: 'resource',
                    template: 'ark_busi_select',
                    busi_data: 'original-transfer',
                    plat: 1,
                    target: 3,
                },
            },
            expect.any(Object),
        );
    });

    it('can read a share-restricted feed while preserving the share refusal', async () => {
        const restrictedFeed = {
            ...feed,
            cell_common: { ...feed.cell_common, operate_mask: 1 << 17 },
        };
        const request = vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({
            retcode: 0,
            data: { feed: { feed: restrictedFeed } },
        });
        const result = await getQzoneFeedDetail(cookies, tid);

        expect(result.feed).toBe(restrictedFeed);
        await expect(getQzoneShareArk(cookies, result.feed)).rejects.toThrow('不支持分享');
        expect(request).toHaveBeenCalledOnce();
    });
});
