import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';
import { ACTION_GROUPS } from '../src/actions';
import { actions } from '../src/actions/qzone-public';
import type { JsonObject } from '../src/types';

const feed = {
    cell_common: {
        union_id: { feed_id: 'opaque-id', ext_ids: [{ future: true }] },
        cur_like_key: 'like-key',
    },
    cell_feed_transfer: { opaque: [1, 'token'] },
    cell_future: { kept: true },
};
const comment = {
    id: 'comment-id',
    user: { uid: 'commenter' },
    reply_attach_info: 'comment-cursor',
};
const reply = { id: 'reply-id', user: { uid: 'recipient' }, future: true };
const result = { unknown: { preserved: [1, 2] } };

function makeHandler(qzone: Record<string, unknown>): ApiHandler {
    const bridge = { apis: { qzone } } as unknown as BridgeInterface;
    return new ApiHandler({ bridge } as ApiActionContext);
}

const cases: {
    action: string;
    method: string;
    params: JsonObject;
    args: unknown[];
    readOnly: boolean;
}[] = [
    {
        action: 'get_qzone_public_capabilities',
        method: 'getPublicCapabilities',
        params: {},
        args: [],
        readOnly: true,
    },
    {
        action: 'get_qzone_public_feeds',
        method: 'getPublicFeeds',
        params: {},
        args: [undefined],
        readOnly: true,
    },
    {
        action: 'get_qzone_public_feed_detail',
        method: 'getPublicFeedDetail',
        params: { feed },
        args: [feed],
        readOnly: true,
    },
    {
        action: 'get_qzone_public_comments',
        method: 'getPublicComments',
        params: { feed, cursor: 'comments-cursor' },
        args: [feed, 'comments-cursor'],
        readOnly: true,
    },
    {
        action: 'get_qzone_public_replies',
        method: 'getPublicReplies',
        params: { feed, comment },
        args: [feed, comment, '', 20],
        readOnly: true,
    },
    {
        action: 'set_qzone_public_upvote',
        method: 'setPublicUpvote',
        params: { feed },
        args: [feed, true],
        readOnly: false,
    },
    {
        action: 'set_qzone_public_like',
        method: 'setPublicLike',
        params: { feed },
        args: [feed, true],
        readOnly: false,
    },
    {
        action: 'set_qzone_public_comment_like',
        method: 'setPublicCommentLike',
        params: { feed, comment },
        args: [feed, comment, true, undefined],
        readOnly: false,
    },
    {
        action: 'comment_qzone_public_feed',
        method: 'commentPublicFeed',
        params: { feed, content: 'hello' },
        args: [feed, 'hello'],
        readOnly: false,
    },
    {
        action: 'reply_qzone_public_feed',
        method: 'replyPublicFeed',
        params: { feed, comment, content: 'reply' },
        args: [feed, comment, 'reply', undefined],
        readOnly: false,
    },
    {
        action: 'delete_qzone_public_comment',
        method: 'deletePublicComment',
        params: { feed, comment },
        args: [feed, comment],
        readOnly: false,
    },
    {
        action: 'delete_qzone_public_reply',
        method: 'deletePublicReply',
        params: { feed, comment, reply },
        args: [feed, comment, reply],
        readOnly: false,
    },
    {
        action: 'set_qzone_public_follow',
        method: 'setPublicFollow',
        params: { feed },
        args: [feed, true],
        readOnly: false,
    },
    {
        action: 'forward_qzone_public_feed',
        method: 'forwardPublicFeed',
        params: { feed },
        args: [feed, ''],
        readOnly: false,
    },
];

describe('qzone public actions', () => {
    it.each(cases)(
        '$action preserves upstream objects and applies documented defaults',
        async ({ action, method, params, args }) => {
            const invoke = vi.fn().mockResolvedValue(result);

            expect(await makeHandler({ [method]: invoke }).handle(action, params)).toMatchObject({
                status: 'ok',
                retcode: 0,
                data: result,
            });
            expect(invoke).toHaveBeenCalledExactlyOnceWith(...args);
        },
    );

    it('registers all public actions under the existing space category with valid examples and read/write modes', () => {
        const registered = ACTION_GROUPS.find((group) => group.category === '空间')!.actions;

        expect(actions).toHaveLength(cases.length);

        for (const { action, readOnly } of cases) {
            const spec = actions.find((entry) => entry.names.includes(action))!;
            const doc = spec.describe();
            expect(registered).toContain(spec);
            expect(doc.readOnly).toBe(readOnly);
            expect(doc.returnsSchema).toBeDefined();
            expect(doc.examples!.length).toBeGreaterThan(0);

            for (const example of doc.examples!) {
                expect(spec.parse(example.params)).toMatchObject({ ok: true });
            }
        }
    });

    it('keeps list metadata and explicit cursor values intact', async () => {
        const page = {
            feeds: [feed],
            has_more: true,
            next_cursor: 'next-cursor',
            server_metadata: { future: 1 },
        };
        const getPublicFeeds = vi.fn().mockResolvedValue(page);

        expect(
            await makeHandler({ getPublicFeeds }).handle('get_qzone_public_feeds', {
                cursor: 'current-cursor',
            }),
        ).toMatchObject({ status: 'ok', data: page });
        expect(getPublicFeeds).toHaveBeenCalledWith('current-cursor');
    });

    it.each(['set_qzone_public_upvote', 'set_qzone_public_like', 'set_qzone_public_follow'])(
        '%s accepts false without replacing it with the true default',
        async (action) => {
            const { method } = cases.find((entry) => entry.action === action)!;
            const invoke = vi.fn().mockResolvedValue(result);

            await makeHandler({ [method]: invoke }).handle(action, { feed, enable: 'false' });
            expect(invoke).toHaveBeenCalledWith(feed, false);
        },
    );

    it('normalizes query-string reply pagination and preserves the parent object', async () => {
        const getPublicReplies = vi.fn().mockResolvedValue(result);

        await makeHandler({ getPublicReplies }).handle('get_qzone_public_replies', {
            feed,
            comment,
            cursor: 'reply-cursor',
            page_size: '5',
        });
        expect(getPublicReplies).toHaveBeenCalledWith(feed, comment, 'reply-cursor', 5);
    });

    it('routes a reply unlike with its original target and parent context', async () => {
        const setPublicCommentLike = vi.fn().mockResolvedValue(result);
        const originalReply = { ...reply, like: { id: 'reply-like-key', future: true } };

        await makeHandler({ setPublicCommentLike }).handle('set_qzone_public_comment_like', {
            feed,
            comment,
            reply: originalReply,
            enable: 'false',
        });
        expect(setPublicCommentLike).toHaveBeenCalledExactlyOnceWith(
            feed,
            comment,
            false,
            originalReply,
        );
    });

    it.each(['comment_qzone_public_feed', 'reply_qzone_public_feed'])(
        '%s preserves every rich item and optional reply recipient',
        async (action) => {
            const { method } = cases.find((entry) => entry.action === action)!;
            const invoke = vi.fn().mockResolvedValue(result);
            const rich = [
                { type: 0, content: 'hello', future: { unknown: true } },
                { type: 1, unknown: [1, 2] },
            ];
            const params = { feed, comment, content: rich, reply };

            await makeHandler({ [method]: invoke }).handle(action, params);
            expect(invoke).toHaveBeenCalledWith(
                ...(action === 'comment_qzone_public_feed'
                    ? [feed, rich]
                    : [feed, comment, rich, reply]),
            );
        },
    );

    it.each(['comment_qzone_public_feed', 'reply_qzone_public_feed'])(
        '%s preserves literal text even when it looks like JSON',
        async (action) => {
            const { method } = cases.find((entry) => entry.action === action)!;
            const invoke = vi.fn().mockResolvedValue(result);
            const handler = makeHandler({ [method]: invoke });

            for (const content of [
                '[]',
                '[1,2]',
                '[{"type":0,"content":"hello"}]',
                '  ["中文"]\n',
                '{"text":"hello"}',
            ]) {
                expect(
                    await handler.handle(action, { feed, comment, content, reply }),
                ).toMatchObject({
                    status: 'ok',
                    retcode: 0,
                });
                expect(invoke).toHaveBeenLastCalledWith(
                    ...(action === 'comment_qzone_public_feed'
                        ? [feed, content]
                        : [feed, comment, content, reply]),
                );
            }
        },
    );

    it.each(['comment_qzone_public_feed', 'reply_qzone_public_feed'])(
        '%s rejects missing, empty, scalar or mixed content without effects',
        async (action) => {
            const { method } = cases.find((entry) => entry.action === action)!;
            const invoke = vi.fn();
            const handler = makeHandler({ [method]: invoke });
            const invalid: JsonObject[] = [
                {},
                { content: '' },
                { content: [] },
                { content: 1 },
                { content: null },
                { content: {} },
                { content: [{ type: 0 }, null] },
                { content: [{ type: 0 }, 'invalid'] },
            ];

            for (const params of invalid) {
                expect(await handler.handle(action, { feed, comment, ...params })).toMatchObject({
                    status: 'failed',
                    retcode: 1400,
                });
            }

            expect(invoke).not.toHaveBeenCalled();
        },
    );

    it.each([
        { action: 'get_qzone_public_feeds', params: { cursor: '' } },
        { action: 'get_qzone_public_feeds', params: { cursor: 'a'.repeat(65537) } },
        { action: 'get_qzone_public_feed_detail', params: {} },
        { action: 'get_qzone_public_feed_detail', params: { feed: [] } },
        { action: 'get_qzone_public_comments', params: { feed } },
        { action: 'get_qzone_public_comments', params: { feed, cursor: '' } },
        { action: 'get_qzone_public_replies', params: { feed, comment: null } },
        { action: 'get_qzone_public_replies', params: { feed, comment, page_size: 0 } },
        { action: 'delete_qzone_public_comment', params: { feed } },
        { action: 'set_qzone_public_comment_like', params: { feed } },
        { action: 'set_qzone_public_comment_like', params: { feed, comment, reply: [] } },
        { action: 'delete_qzone_public_reply', params: { feed, comment, reply: 'bad' } },
        {
            action: 'reply_qzone_public_feed',
            params: { feed, comment, content: 'reply', reply: [] },
        },
    ])('$action rejects invalid parameters before dispatch', async ({ action, params }) => {
        const { method } = cases.find((entry) => entry.action === action)!;
        const invoke = vi.fn();

        expect(
            await makeHandler({ [method]: invoke }).handle(action, params as JsonObject),
        ).toMatchObject({ status: 'failed', retcode: 1400 });
        expect(invoke).not.toHaveBeenCalled();
    });

    it.each(['get_qzone_public_feed_detail', 'set_qzone_public_upvote'])(
        '%s exposes upstream errors without retry',
        async (action) => {
            const { method, params } = cases.find((entry) => entry.action === action)!;
            const invoke = vi.fn().mockRejectedValue(new Error('public qzone denied'));

            expect(await makeHandler({ [method]: invoke }).handle(action, params)).toMatchObject({
                status: 'failed',
                wording: 'public qzone denied',
            });
            expect(invoke).toHaveBeenCalledTimes(1);
        },
    );
});
