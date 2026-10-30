import { afterEach, describe, expect, it, vi } from 'vitest';
import { getQzoneHomeFeeds, getQzoneShareArk } from '../../src/web/qzone-public';
import { RequestUtil } from '../../src/web/request-util';

const cookies = { p_skey: 'test', uin: 'o10001' };
const feed = {
    cell_common: { union_id: { feed_id: 'feed-id' }, operate_mask: 0 },
    cell_operation: {
        share_outside: { share_access_resource: { busi_id: 'qzone_feed', resource_id: 'opaque' } },
    },
    cell_feed_transfer: 'original-transfer',
    unknown: { keep: true },
};
const ark = '{ "app": "com.tencent.tuwen.lua", "config": {"token":"fixture"} }';
const request = (data: unknown) =>
    vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({ retcode: 0, data });

afterEach(() => vi.restoreAllMocks());

describe('Qzone share card', () => {
    it('generates the original card and returns the upstream confirmation notice', async () => {
        const req = request({
            template_data: ark,
            err: { code: 0 },
            info: {
                busi_data: Buffer.from(
                    JSON.stringify({ need_break: true, tips: { content: '分享后所有人可见' } }),
                ).toString('base64'),
            },
        });
        await expect(getQzoneShareArk(cookies, feed)).resolves.toEqual({
            ark,
            requires_confirmation: true,
            notice: '分享后所有人可见',
        });
        expect(req).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining('/trpc.qq.share.Service/CreateShare?g_tk='),
            'POST',
            {
                info: {
                    busi_id: 'qzone_feed',
                    resource_id: 'opaque',
                    template: 'ark_busi_select',
                    busi_data: 'original-transfer',
                    plat: 1,
                    target: 3,
                },
            },
            expect.objectContaining({
                'x-oidb': JSON.stringify({ uint32_command: '0x9409', uint32_service_type: '1' }),
                Cookie: 'p_skey=test; uin=o10001',
            }),
        );
    });

    it('preserves a valid card without a confirmation notice', async () => {
        request({ template_data: ark, err: {} });
        await expect(getQzoneShareArk(cookies, feed)).resolves.toEqual({
            ark,
            requires_confirmation: false,
            notice: null,
        });
    });

    it('rejects unavailable sharing and incomplete feeds before requesting a card', async () => {
        const req = request({ template_data: ark });
        await expect(
            getQzoneShareArk(cookies, { ...feed, cell_common: { operate_mask: 1 << 17 } }),
        ).rejects.toThrow('不支持分享');
        await expect(
            getQzoneShareArk(cookies, { ...feed, cell_feed_transfer: '' }),
        ).rejects.toThrow('缺少分享信息');
        await expect(getQzoneShareArk(cookies, {})).rejects.toThrow('缺少分享信息');
        expect(req).not.toHaveBeenCalled();
    });

    it.each([
        [{ err: { code: 3, msg: '参数错误' }, template_data: ark }, '3 参数错误'],
        [{ err: { code: '0' }, template_data: ark }, '业务响应异常'],
        [{}, '未返回卡片'],
        [{ template_data: '[]' }, '卡片格式异常'],
        [{ template_data: ark, info: { busi_data: '!' } }, '提示编码异常'],
        [{ template_data: ark, info: { busi_data: Buffer.from('{').toString('base64') } }, 'JSON'],
    ])('surfaces rejected or malformed share responses', async (data, error) => {
        request(data);
        await expect(getQzoneShareArk(cookies, feed)).rejects.toThrow(error);
    });

    it('propagates access errors without a retry', async () => {
        const req = request(null).mockResolvedValue({ retcode: 10023, message: '无权限访问' });
        await expect(getQzoneShareArk(cookies, feed)).rejects.toThrow('10023 无权限访问');
        expect(req).toHaveBeenCalledOnce();
    });
});

describe('Qzone homepage feeds', () => {
    it('reads own homepage and preserves full cells across explicit pagination', async () => {
        const req = request({ feeds: [{ feed }], has_more: true, attach_info: 'next', extra: 1 });
        const first = await getQzoneHomeFeeds(cookies, '10001');
        expect(first).toMatchObject({ feeds: [feed], has_more: true, extra: 1 });
        expect(req.mock.calls[0]![2]).toEqual({
            host_uid: '',
            host_uin: '10001',
            attach_info: '',
            refresh_attach_info: '',
            feed_action_domain_type: 1,
        });
        req.mockResolvedValueOnce({ retcode: 0, data: { feeds: [], has_more: false } });
        await expect(
            getQzoneHomeFeeds(cookies, '10001', undefined, first.next_cursor!),
        ).resolves.toEqual({ feeds: [], has_more: false, next_cursor: null });
        expect(req.mock.calls[1]![2]).toMatchObject({ attach_info: 'next' });
    });

    it('rejects a cursor reused for another account, homepage or stream', async () => {
        const req = request({ feeds: [{ feed }], has_more: true, attach_info: 'next' });
        const first = await getQzoneHomeFeeds(cookies, '10001');
        req.mockClear();

        for (const [self, host, cursor] of [
            ['20002', '10001', first.next_cursor!],
            ['10001', '20002', first.next_cursor!],
            [
                '10001',
                '10001',
                Buffer.from(
                    JSON.stringify({
                        version: 1,
                        uin: '10001',
                        attach_info: 'next',
                        refresh_id: 'x',
                    }),
                ).toString('base64url'),
            ],
        ]) {
            await expect(getQzoneHomeFeeds(cookies, self!, host!, cursor!)).rejects.toThrow(
                'cursor',
            );
        }

        expect(req).not.toHaveBeenCalled();
    });

    it('surfaces missing or stalled pagination and permission failures', async () => {
        const req = request({ feeds: [], has_more: true });
        await expect(getQzoneHomeFeeds(cookies, '10001')).rejects.toThrow('分页未推进');
        req.mockResolvedValue({ retcode: 10023, message: '无权限访问' });
        await expect(getQzoneHomeFeeds(cookies, '10001', '20002')).rejects.toThrow(
            '10023 无权限访问',
        );
    });
});
