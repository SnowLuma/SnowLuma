import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@snowluma/common/json';
import * as qzone from '@snowluma/protocol/web/qzone-public';
import { RequestUtil, getBknFromCookie } from '@snowluma/protocol/web/request-util';

const cookies = { p_skey: 'test-pskey', uin: 'o10001' };
const union: JsonObject = {
    uf_key: 'feed-1',
    ugc_id: '9007199254740999',
    feed_id: 'feed-id',
    ext_ids: [{ numeric: '9007199254740999' }],
};
const feed: JsonObject = {
    cell_common: { union_id: union, feed_type: 1, domain_type: 3, cur_like_key: 'like-key' },
    cell_feed_transfer: { opaque: 'transfer' },
    cell_user_info: { user: { uid: 'author-uid', uin: '20002', nick: '作者' } },
    cell_unknown: { keep: true },
};
const user = { uin: '10001', uid: 'self-uid', nick: '我' };
const comment = {
    id: 'comment-1',
    user: { uin: '20002', uid: 'comment-uid', nick: '' },
    reply_attach_info: 'reply-first',
    opaque: true,
};
const reply = { id: 'reply-1', user: { uin: '30003', uid: 'reply-uid', nick: '' } };
const baseParams = { union_id: union, cell_feed_transfer: feed.cell_feed_transfer };

function mockRequest(data: JsonObject = {}) {
    return vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({ retcode: 0, data });
}

function body(request: ReturnType<typeof mockRequest>, index = 0): JsonObject {
    return request.mock.calls[index]![2] as JsonObject;
}

afterEach(() => vi.restoreAllMocks());

describe('public Qzone reader', () => {
    it('uses the JSON gateway with the current account cookies and the method oidb headers', async () => {
        const flags = { public_qzone_entrance_switch: true, can_upvote: true, unknown_flag: false };
        const request = mockRequest({
            results: [
                { uin: '20002', entrances: {} },
                { uin: '10001', entrances: flags },
            ],
        });
        await expect(qzone.getQzonePublicCapabilities(cookies, '10001')).resolves.toEqual(flags);
        const [url, method, , headers] = request.mock.calls[0]!;
        expect(url).toBe(
            `https://h5.qzone.qq.com/http2rpc/gotrpc/v1/trpc.public_qzone.entrance_ctrl.EntranceCtrl/BatchEntranceWhitelist?g_tk=${getBknFromCookie(cookies)}`,
        );
        expect(method).toBe('POST');
        expect(body(request)).toEqual({ uins: ['10001'], entrance_types: [1, 15] });
        expect(headers).toEqual({
            Cookie: 'p_skey=test-pskey; uin=o10001',
            'Content-Type': 'application/json',
            Referer: 'https://h5.qzone.qq.com/pc-qzone/index.html',
            'x-web-qua': 'V1_HT5_QZ_9.9.32_001_IDC_B',
            'x-oidb': JSON.stringify({ uint32_command: '0x9741', uint32_service_type: '0' }),
        });
    });

    it('continues short and ad-only pages using the full last non-ad union and server has_more', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(12345);
        const ad = { cell_common: { feed_type: 3, union_id: { uf_key: 'ad' } } };
        const request = mockRequest()
            .mockResolvedValueOnce({
                retcode: 0,
                data: { feeds: [{ feed }], has_more: true, attach_info: 'page-2', extra: 'keep' },
            })
            .mockResolvedValueOnce({
                retcode: 0,
                data: { feeds: [{ feed: ad }], has_more: true, attach_info: 'page-3' },
            })
            .mockResolvedValueOnce({ retcode: 0, data: { feeds: [], has_more: false } });
        const first = await qzone.getQzonePublicFeeds(cookies, '10001');
        expect(first).toMatchObject({ feeds: [feed], has_more: true, extra: 'keep' });
        expect(body(request)).toEqual({ refresh_id: '10001_12345' });
        const second = await qzone.getQzonePublicFeeds(cookies, '10001', first.next_cursor!);
        expect(body(request, 1)).toEqual({
            refresh_id: '10001_12345',
            attach_info: 'page-2',
            last_client_feed_union_id: union,
        });
        const last = await qzone.getQzonePublicFeeds(cookies, '10001', second.next_cursor!);
        expect(body(request, 2)).toEqual({
            refresh_id: '10001_12345',
            attach_info: 'page-3',
            last_client_feed_union_id: union,
        });
        expect(last).toEqual({ feeds: [], has_more: false, next_cursor: null });
        expect(request).toHaveBeenCalledTimes(3);
    });

    it('preserves unknown feed cells without using them as pagination anchors', async () => {
        const unknown = { cell_common: { feed_type: 4 }, cell_unknown: { keep: true } };
        const request = mockRequest({
            feeds: [{ feed }, { feed: unknown }],
            has_more: true,
            attach_info: 'next',
        });
        const first = await qzone.getQzonePublicFeeds(cookies, '10001');
        expect(first.feeds).toEqual([feed, unknown]);
        request.mockResolvedValueOnce({
            retcode: 0,
            data: { feeds: [{ feed: unknown }], has_more: true, attach_info: 'after-unknown' },
        });
        const next = await qzone.getQzonePublicFeeds(cookies, '10001', first.next_cursor!);
        request.mockResolvedValueOnce({ retcode: 0, data: { feeds: [], has_more: false } });
        await qzone.getQzonePublicFeeds(cookies, '10001', next.next_cursor!);
        expect(body(request, 2).last_client_feed_union_id).toEqual(union);
    });

    it('rejects malformed or cross-account cursors before a network request', async () => {
        const request = mockRequest({ feeds: [{ feed }], has_more: true, attach_info: 'next' });
        const first = await qzone.getQzonePublicFeeds(cookies, '10001');
        request.mockClear();

        for (const cursor of [
            '',
            '!',
            'a'.repeat(65537),
            Buffer.from('{}').toString('base64url'),
            first.next_cursor!,
        ]) {
            await expect(qzone.getQzonePublicFeeds(cookies, '20002', cursor)).rejects.toThrow(
                /cursor/,
            );
        }

        expect(request).not.toHaveBeenCalled();
    });

    it.each([
        { feeds: [], has_more: true },
        { feeds: [{ feed: null }], has_more: false },
        { feeds: null, has_more: false },
        { feeds: [], has_more: 1 },
    ])('reports invalid upstream page data (%j)', async (data) => {
        mockRequest(data);
        await expect(qzone.getQzonePublicFeeds(cookies, '10001')).rejects.toThrow(
            /GetPublicRecomFeeds/,
        );
    });

    it('preserves detail/comment/reply result fields and forwards their separate pagination state', async () => {
        const detail = {
            feed: { feed: { ...feed, cell_comment: { comments: [comment] } } },
            attach_info: 'comments-next',
            has_more: true,
        };
        const request = mockRequest(detail);
        await expect(qzone.getQzonePublicFeedDetail(cookies, feed)).resolves.toEqual(detail);
        expect(body(request)).toEqual({ ...baseParams, feed_action_domain_type: 3, from_page: 1 });
        request.mockResolvedValueOnce({
            retcode: 0,
            data: {
                cell_comment: { comments: [comment] },
                attach_info: 'comments-end',
                has_more: false,
            },
        });
        await qzone.getQzonePublicComments(cookies, feed, 'comments-next');
        expect(body(request, 1)).toEqual({ ...baseParams, attach_info: 'comments-next' });
        request.mockResolvedValue({
            retcode: 0,
            data: { replys: [reply], reply_attach_info: 'reply-next', has_more: true },
        });
        await qzone.getQzonePublicReplies(cookies, feed, comment, '', 20);
        expect(body(request, 2)).toEqual({
            ...baseParams,
            cur_comment: comment,
            comment_attach_info: '',
            reply_attach_info: 'reply-first',
            page_size: 20,
        });
        await qzone.getQzonePublicReplies(cookies, feed, comment, 'reply-next', 5);
        expect(body(request, 3).reply_attach_info).toBe('reply-next');
    });
});

describe('public Qzone interactions', () => {
    it.each([
        [true, 'Upvote', '0x9d18', qzone.setQzonePublicUpvote, { upvote: { num: 1 } }],
        [false, 'Downvote', '0x9d19', qzone.setQzonePublicUpvote, { upvote: { num: 0 } }],
        [true, 'DoLike', '0x9699', qzone.setQzonePublicLike, { like: { num: 1 } }],
        [false, 'UnLike', '0x969c', qzone.setQzonePublicLike, { like: { num: 0 } }],
    ] as const)(
        'sends %s to %s with its own success field',
        async (enable, method, command, invoke, result) => {
            const request = mockRequest(result);
            await expect(invoke(cookies, feed, enable)).resolves.toEqual(result);
            expect(request.mock.calls[0]![0]).toContain(`/${method}?`);
            expect(JSON.parse(request.mock.calls[0]![3]!['x-oidb']!)).toEqual({
                uint32_command: command,
                uint32_service_type: '1',
            });
            expect(body(request)).toEqual(
                method.includes('Like')
                    ? { ...baseParams, like_key: 'like-key', like_type: 1 }
                    : baseParams,
            );
        },
    );

    it('encodes text as plain RichItem and retains rich arrays and reply target identities', async () => {
        const request = mockRequest({ comment });
        await qzone.commentQzonePublicFeed(cookies, feed, user, '中文 & +\n第二行');
        expect(body(request)).toEqual({
            ...baseParams,
            comment: { user, content: [{ type: 0, content: '中文 & +\n第二行' }] },
        });
        const rich = [
            { type: 0, content: '文字' },
            { type: 2, unknown: { keep: true } },
        ];
        request.mockResolvedValue({ retcode: 0, data: { reply } });
        await qzone.replyQzonePublicFeed(cookies, feed, user, comment, rich);
        expect(body(request, 1)).toEqual({
            ...baseParams,
            comment,
            reply: { user, target_user: comment.user, content: rich },
        });
        await qzone.replyQzonePublicFeed(cookies, feed, user, comment, '回复', reply);
        expect((body(request, 2).reply as JsonObject).target_user).toEqual(reply.user);
    });

    it('likes comments and replies using their upstream like.id rather than comment IDs', async () => {
        const request = mockRequest({ like: { count: 1 } });
        await qzone.setQzonePublicCommentLike(
            cookies,
            feed,
            { ...comment, like: { id: 'comment-like-key' } },
            true,
        );
        expect(body(request)).toEqual({
            ...baseParams,
            like_key: 'comment-like-key',
            like_type: 2,
        });
        await qzone.setQzonePublicCommentLike(cookies, feed, comment, false, {
            ...reply,
            like: { id: 'reply-like-key' },
        });
        expect(body(request, 1)).toEqual({
            ...baseParams,
            like_key: 'reply-like-key',
            like_type: 3,
        });
        await expect(qzone.setQzonePublicCommentLike(cookies, feed, comment, true)).rejects.toThrow(
            /like_key/,
        );
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('passes complete comment/reply objects for deletion and forwards without a second comment', async () => {
        const request = mockRequest({ unknown: 'keep' });
        await qzone.deleteQzonePublicComment(cookies, feed, comment);
        expect(body(request)).toEqual({ ...baseParams, comment });
        await qzone.deleteQzonePublicReply(cookies, feed, comment, reply);
        expect(body(request, 1)).toEqual({ ...baseParams, comment, reply });
        await qzone.forwardQzonePublicFeed(cookies, feed, '');
        expect(body(request, 2)).toEqual({ ...baseParams, reason: '' });
        expect(request.mock.calls[2]![0]).toContain(
            '/trpc.qzone.feeds_writer.FeedsWriter/ForwardFeed?',
        );
        expect(request).toHaveBeenCalledTimes(3);
    });

    it('follows public authors by uid and other authors by uin, exposing nested relation failures', async () => {
        const request = mockRequest({ ret_code: '0' });
        await qzone.setQzonePublicFollow(cookies, feed, true);
        expect(body(request)).toEqual({
            follow_from_type: 1,
            target_uid: 'author-uid',
            follow_feed_id: 'feed-1',
            cell_feed_transfer: feed.cell_feed_transfer,
        });
        const other = {
            ...feed,
            cell_common: { ...(feed.cell_common as JsonObject), domain_type: 1 },
        };
        await qzone.setQzonePublicFollow(cookies, other, false);
        expect(body(request, 1).target_uin).toBe('20002');
        expect(request.mock.calls[1]![0]).toContain('/Unfollow?');
        request.mockResolvedValueOnce({ retcode: 0, data: { ret_code: 403, ret_msg: 'denied' } });
        await expect(qzone.setQzonePublicFollow(cookies, feed, true)).rejects.toThrow(
            'ret_code=403 denied',
        );
    });

    it('rejects missing operation identities before writing', async () => {
        const request = mockRequest();
        expect(() => qzone.forwardQzonePublicFeed(cookies, {}, '')).toThrow(/union_id/);
        await expect(
            qzone.setQzonePublicLike(cookies, { cell_common: { union_id: union } }, true),
        ).rejects.toThrow(/like_key/);
        await expect(
            qzone.setQzonePublicFollow(cookies, { cell_common: { union_id: union } }, true),
        ).rejects.toThrow(/uid\/uin/);
        await expect(qzone.replyQzonePublicFeed(cookies, feed, user, {}, 'text')).rejects.toThrow(
            /user/,
        );
        expect(request).not.toHaveBeenCalled();
    });
});

describe('public Qzone errors', () => {
    it.each([
        null,
        {},
        { retcode: 0 },
        { retcode: 0, data: [] },
        { retcode: 4003, message: 'need login' },
    ])('does not report malformed or failed envelopes as success (%j)', async (response) => {
        const request = vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(response);
        await expect(qzone.getQzonePublicFeedDetail(cookies, feed)).rejects.toThrow(
            /qzone public GetFeedDetail failed/,
        );
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('propagates transport errors and does not retry writes or accept missing success fields', async () => {
        const request = mockRequest().mockRejectedValueOnce(new Error('connection closed'));
        await expect(qzone.commentQzonePublicFeed(cookies, feed, user, 'text')).rejects.toThrow(
            'connection closed',
        );
        await expect(qzone.setQzonePublicLike(cookies, feed, true)).rejects.toThrow(/缺少 like/);
        await expect(qzone.setQzonePublicUpvote(cookies, feed, false)).rejects.toThrow(
            /缺少 upvote/,
        );
        await expect(qzone.commentQzonePublicFeed(cookies, feed, user, 'text')).rejects.toThrow(
            /缺少 comment/,
        );
        await expect(
            qzone.replyQzonePublicFeed(cookies, feed, user, comment, 'text'),
        ).rejects.toThrow(/缺少 reply/);
        expect(request).toHaveBeenCalledTimes(5);
    });
});
