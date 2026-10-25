import { afterEach, describe, expect, it, vi } from 'vitest';
import * as qzonePublic from '@snowluma/protocol/web/qzone-public';
import { QzoneApi } from '../../src/bridge/apis/qzone';
import { mockApiHub, mockBridge } from './_helpers';

const cookies = { p_skey: 'PSK' };
const feed = {
    cell_common: { union_id: { feed_id: 'opaque-id' } },
    cell_feed_transfer: { future: true },
};
const comment = { id: 'comment-id', user: { uid: 'commenter' }, unknown: [1, 2] };
const reply = { id: 'reply-id', user: { uid: 'recipient' } };
const content = [{ type: 0, content: 'text', future: { enabled: true } }];
const user = { uin: '10001', uid: 'self-uid', nick: 'self-nick' };
const result = { feeds: [], has_more: false, next_cursor: null, unknown: { preserved: true } };

function makeApi() {
    const getCookies = vi.fn().mockResolvedValue(cookies);
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    return { api: new QzoneApi(bridge as never), bridge, getCookies };
}

const cases = [
    {
        method: 'getQzonePublicCapabilities',
        invoke: (api: QzoneApi) => api.getPublicCapabilities(),
        args: [cookies, '10001'],
    },
    {
        method: 'getQzonePublicFeeds',
        invoke: (api: QzoneApi) => api.getPublicFeeds('cursor'),
        args: [cookies, '10001', 'cursor'],
    },
    {
        method: 'getQzonePublicFeedDetail',
        invoke: (api: QzoneApi) => api.getPublicFeedDetail(feed),
        args: [cookies, feed],
    },
    {
        method: 'getQzonePublicComments',
        invoke: (api: QzoneApi) => api.getPublicComments(feed, 'cursor'),
        args: [cookies, feed, 'cursor'],
    },
    {
        method: 'getQzonePublicReplies',
        invoke: (api: QzoneApi) => api.getPublicReplies(feed, comment, 'cursor', 5),
        args: [cookies, feed, comment, 'cursor', 5],
    },
    {
        method: 'setQzonePublicUpvote',
        invoke: (api: QzoneApi) => api.setPublicUpvote(feed, false),
        args: [cookies, feed, false],
    },
    {
        method: 'setQzonePublicLike',
        invoke: (api: QzoneApi) => api.setPublicLike(feed, false),
        args: [cookies, feed, false],
    },
    {
        method: 'setQzonePublicCommentLike',
        invoke: (api: QzoneApi) => api.setPublicCommentLike(feed, comment, false, reply),
        args: [cookies, feed, comment, false, reply],
    },
    {
        method: 'commentQzonePublicFeed',
        invoke: (api: QzoneApi) => api.commentPublicFeed(feed, content),
        args: [cookies, feed, user, content],
    },
    {
        method: 'replyQzonePublicFeed',
        invoke: (api: QzoneApi) => api.replyPublicFeed(feed, comment, content, reply),
        args: [cookies, feed, user, comment, content, reply],
    },
    {
        method: 'deleteQzonePublicComment',
        invoke: (api: QzoneApi) => api.deletePublicComment(feed, comment),
        args: [cookies, feed, comment],
    },
    {
        method: 'deleteQzonePublicReply',
        invoke: (api: QzoneApi) => api.deletePublicReply(feed, comment, reply),
        args: [cookies, feed, comment, reply],
    },
    {
        method: 'setQzonePublicFollow',
        invoke: (api: QzoneApi) => api.setPublicFollow(feed, false),
        args: [cookies, feed, false],
    },
    {
        method: 'forwardQzonePublicFeed',
        invoke: (api: QzoneApi) => api.forwardPublicFeed(feed, 'reason'),
        args: [cookies, feed, 'reason'],
    },
] as const;

describe('apis/qzone public', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each(cases)(
        '$method uses current-account cookies and preserves upstream objects',
        async ({ method, invoke, args }) => {
            const { api, getCookies } = makeApi();
            const request = vi.spyOn(qzonePublic, method).mockResolvedValue(result);

            expect(await invoke(api)).toBe(result);
            expect(getCookies).toHaveBeenCalledWith('qzone.qq.com');
            expect(request).toHaveBeenCalledExactlyOnceWith(...args);
        },
    );

    it.each(cases)(
        '$method propagates cookie and upstream failures without replay',
        async ({ method, invoke }) => {
            const { api, getCookies } = makeApi();
            const request = vi
                .spyOn(qzonePublic, method)
                .mockRejectedValue(new Error('upstream denied'));

            await expect(invoke(api)).rejects.toThrow('upstream denied');
            getCookies.mockRejectedValueOnce(new Error('cookie failure'));
            await expect(invoke(api)).rejects.toThrow('cookie failure');
            expect(request).toHaveBeenCalledTimes(1);
        },
    );

    it('keeps documented defaults and omits an optional reply target', async () => {
        const { api } = makeApi();
        const feeds = vi.spyOn(qzonePublic, 'getQzonePublicFeeds').mockResolvedValue(result);
        const replies = vi.spyOn(qzonePublic, 'getQzonePublicReplies').mockResolvedValue(result);
        const upvote = vi.spyOn(qzonePublic, 'setQzonePublicUpvote').mockResolvedValue(result);
        const like = vi.spyOn(qzonePublic, 'setQzonePublicLike').mockResolvedValue(result);
        const commentLike = vi
            .spyOn(qzonePublic, 'setQzonePublicCommentLike')
            .mockResolvedValue(result);
        const follow = vi.spyOn(qzonePublic, 'setQzonePublicFollow').mockResolvedValue(result);
        const forward = vi.spyOn(qzonePublic, 'forwardQzonePublicFeed').mockResolvedValue(result);
        const replyRequest = vi
            .spyOn(qzonePublic, 'replyQzonePublicFeed')
            .mockResolvedValue(result);

        await api.getPublicFeeds();
        await api.getPublicReplies(feed, comment);
        await api.setPublicUpvote(feed);
        await api.setPublicLike(feed);
        await api.setPublicCommentLike(feed, comment);
        await api.setPublicFollow(feed);
        await api.forwardPublicFeed(feed);
        await api.replyPublicFeed(feed, comment, 'text');

        expect(feeds).toHaveBeenCalledWith(cookies, '10001', undefined);
        expect(replies).toHaveBeenCalledWith(cookies, feed, comment, '', 20);
        expect(upvote).toHaveBeenCalledWith(cookies, feed, true);
        expect(like).toHaveBeenCalledWith(cookies, feed, true);
        expect(commentLike).toHaveBeenCalledWith(cookies, feed, comment, true, undefined);
        expect(follow).toHaveBeenCalledWith(cookies, feed, true);
        expect(forward).toHaveBeenCalledWith(cookies, feed, '');
        expect(replyRequest).toHaveBeenCalledWith(cookies, feed, user, comment, 'text', undefined);
    });

    it('binds comment authors to the current account even when its uid is unavailable', async () => {
        const { api, bridge } = makeApi();
        Object.assign(bridge.identity, { selfUid: undefined });
        const request = vi.spyOn(qzonePublic, 'commentQzonePublicFeed').mockResolvedValue(result);

        await api.commentPublicFeed(feed, 'text');
        expect(request).toHaveBeenCalledWith(
            cookies,
            feed,
            { uin: '10001', uid: '', nick: 'self-nick' },
            'text',
        );
    });
});
