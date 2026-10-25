import { defineAction, f } from '../action-kit';
import { okResponse, type JsonObject } from '../types';

const feed = f
    .object()
    .describe('get_qzone_public_feeds 返回的完整 feeds 条目，保留所有原始 cell 字段');
const comment = f.object().describe('详情或评论页返回的完整评论对象，保留 user 等原始字段');
const reply = f.object().describe('评论或回复页返回的完整回复对象，保留 user 等原始字段');
const content = f
    .textOrObjectArray()
    .describe(
        '非空文本，或非空上游 RichItem 对象数组；字符串始终原样发送，富文本请直接传对象数组，不是 OneBot 消息段',
    );
const objectResult = { type: 'object', additionalProperties: true };
const feedSource =
    'feed 必须原样取自 get_qzone_public_feeds 的 feeds 数组，不能用旧说说 tid 拼造；示例中的占位字段须整体替换。';
const commentSource =
    'comment 可取 get_qzone_public_feed_detail 返回的 feed.feed.cell_comment.comments，或后续评论页；保留完整对象。';
const feedExample: JsonObject = {
    cell_common: {
        union_id: {
            uf_key: '<uf_key-from-get_qzone_public_feeds>',
            ugc_id: '<ugc_id>',
            feed_id: '<feed_id>',
            ext_ids: [],
        },
        cur_like_key: '<like-key>',
        domain_type: 3,
    },
    cell_feed_transfer: {},
    cell_user_info: { user: { uin: '10001', uid: '<uid>', nick: '<nick>' } },
};
const commentExample: JsonObject = {
    id: '<comment-id-from-detail-or-comments>',
    user: { uin: '<uin>', uid: '<uid>', nick: '<nick>' },
    like: { id: '<like-id-from-comment>', count: 0, status: 0 },
    reply_attach_info: '',
};
const replyExample: JsonObject = {
    id: '<reply-id-from-comments-or-replies>',
    user: { uin: '<uin>', uid: '<uid>', nick: '<nick>' },
    like: { id: '<like-id-from-reply>', count: 0, status: 0 },
};

export const actions = [
    defineAction({
        name: 'get_qzone_public_capabilities',
        summary: '读取当前账号的空友爱看入口与推权限',
        readOnly: true,
        examples: [{ summary: '查询当前账号是否有空友爱看入口及推能力', params: {} }],
        returns: '当前账号的上游入口能力对象，保留未知字段。',
        returnsSchema: objectResult,
        params: {},
        run: async (_p, ctx) => okResponse(await ctx.bridge.apis.qzone.getPublicCapabilities()),
    }),
    defineAction({
        name: 'get_qzone_public_feeds',
        summary: '读取空友爱看推荐动态，支持独立游标分页',
        readOnly: true,
        examples: [
            { summary: '读取空友爱看推荐首页', params: {} },
            {
                summary: '继续读取推荐动态',
                params: { cursor: '<next_cursor-from-get_qzone_public_feeds>' },
                notes: 'cursor 原样使用上次返回的 next_cursor，仅适用于同一账号；has_more=false 时停止。',
            },
        ],
        returns: '推荐动态原始 cell 对象及分页状态，保留其余上游页面字段。',
        returnsSchema: {
            type: 'object',
            additionalProperties: true,
            properties: {
                feeds: {
                    type: 'array',
                    items: objectResult,
                    description: '原始动态 cell 对象，后续详情和互动需原样传入',
                },
                has_more: { type: 'boolean', description: '服务端是否报告还有下一页' },
                next_cursor: {
                    type: ['string', 'null'],
                    description: '下一页游标；无下一页时为 null',
                },
            },
            required: ['feeds', 'has_more', 'next_cursor'],
        },
        params: {
            cursor: f
                .string({ allowEmpty: false, maxLen: 65536 })
                .describe('上次返回的 next_cursor，省略则刷新首页')
                .optional(),
        },
        run: async (p, ctx) => okResponse(await ctx.bridge.apis.qzone.getPublicFeeds(p.cursor)),
    }),
    defineAction({
        name: 'get_qzone_public_feed_detail',
        summary: '读取推荐动态详情及初始评论',
        readOnly: true,
        examples: [
            { summary: '读取推荐动态详情', params: { feed: feedExample }, notes: feedSource },
        ],
        returns:
            '上游详情 data；初始评论位于 feed.feed.cell_comment.comments，续页使用 attach_info。',
        returnsSchema: objectResult,
        params: { feed },
        run: async (p, ctx) => okResponse(await ctx.bridge.apis.qzone.getPublicFeedDetail(p.feed)),
    }),
    defineAction({
        name: 'get_qzone_public_comments',
        summary: '继续读取推荐动态评论',
        readOnly: true,
        examples: [
            {
                summary: '读取详情之后的下一页评论',
                params: { feed: feedExample, cursor: '<attach_info-from-detail-or-comments>' },
                notes: `${feedSource} 先读详情获取初始评论及 attach_info，再原样传入 cursor。`,
            },
        ],
        returns: '上游评论页对象，保留评论、分页和未知字段。',
        returnsSchema: objectResult,
        params: {
            feed,
            cursor: f.string({ allowEmpty: false }).describe('详情或上一评论页返回的 attach_info'),
        },
        run: async (p, ctx) =>
            okResponse(await ctx.bridge.apis.qzone.getPublicComments(p.feed, p.cursor)),
    }),
    defineAction({
        name: 'get_qzone_public_replies',
        summary: '继续读取指定评论的回复',
        readOnly: true,
        examples: [
            {
                summary: '读取某条评论的后续回复',
                params: { feed: feedExample, comment: commentExample },
                notes: `${feedSource} ${commentSource} 首次续读使用评论自带的 reply_attach_info；之后传上一回复页的游标。`,
            },
        ],
        returns: '上游回复页对象，保留回复、分页和未知字段。',
        returnsSchema: objectResult,
        params: {
            feed,
            comment,
            cursor: f
                .string()
                .describe('上一回复页的 reply_attach_info；省略则使用评论自带游标')
                .default(''),
            page_size: f.int({ min: 1 }).describe('请求的回复数量').default(20),
        },
        run: async (p, ctx) =>
            okResponse(
                await ctx.bridge.apis.qzone.getPublicReplies(
                    p.feed,
                    p.comment,
                    p.cursor,
                    p.page_size,
                ),
            ),
    }),
    defineAction({
        name: 'set_qzone_public_upvote',
        summary: '推或取消推空友爱看动态（独立于普通赞）',
        readOnly: false,
        examples: [
            {
                summary: '推一条推荐动态',
                params: { feed: feedExample, enable: true },
                notes: feedSource,
            },
        ],
        returns: '上游推操作结果，保留未知字段。',
        returnsSchema: objectResult,
        params: { feed, enable: f.bool().describe('true 推，false 取消推').default(true) },
        run: async (p, ctx) =>
            okResponse(await ctx.bridge.apis.qzone.setPublicUpvote(p.feed, p.enable)),
    }),
    defineAction({
        name: 'set_qzone_public_like',
        summary: '点赞或取消赞推荐动态',
        readOnly: false,
        examples: [
            {
                summary: '点赞推荐动态',
                params: { feed: feedExample, enable: true },
                notes: feedSource,
            },
        ],
        returns: '上游普通赞操作结果，保留未知字段。',
        returnsSchema: objectResult,
        params: { feed, enable: f.bool().describe('true 点赞，false 取消赞').default(true) },
        run: async (p, ctx) =>
            okResponse(await ctx.bridge.apis.qzone.setPublicLike(p.feed, p.enable)),
    }),
    defineAction({
        name: 'set_qzone_public_comment_like',
        summary: '点赞或取消赞推荐动态中的评论或回复',
        readOnly: false,
        examples: [
            {
                summary: '点赞一条评论',
                params: { feed: feedExample, comment: commentExample },
                notes: `${feedSource} ${commentSource} 必须保留评论原始 like.id。`,
            },
            {
                summary: '取消赞某条回复',
                params: {
                    feed: feedExample,
                    comment: commentExample,
                    reply: replyExample,
                    enable: false,
                },
                notes: `${feedSource} reply 使用该评论下的完整回复对象，保留其原始 like.id。`,
            },
        ],
        returns: '上游普通赞操作结果，保留未知字段。',
        returnsSchema: objectResult,
        params: {
            feed,
            comment,
            enable: f.bool().describe('true 点赞，false 取消赞').default(true),
            reply: reply.optional(),
        },
        run: async (p, ctx) =>
            okResponse(
                await ctx.bridge.apis.qzone.setPublicCommentLike(
                    p.feed,
                    p.comment,
                    p.enable,
                    p.reply,
                ),
            ),
    }),
    defineAction({
        name: 'comment_qzone_public_feed',
        summary: '评论推荐动态，支持文本或上游富文本条目',
        readOnly: false,
        examples: [
            {
                summary: '评论推荐动态',
                params: { feed: feedExample, content: '感谢分享' },
                notes: feedSource,
            },
        ],
        returns: '上游评论结果，包含新评论，保留未知字段。',
        returnsSchema: objectResult,
        params: { feed, content },
        run: async (p, ctx) =>
            okResponse(await ctx.bridge.apis.qzone.commentPublicFeed(p.feed, p.content)),
    }),
    defineAction({
        name: 'reply_qzone_public_feed',
        summary: '回复推荐动态的评论或其中某条回复',
        readOnly: false,
        examples: [
            {
                summary: '回复一条评论',
                params: { feed: feedExample, comment: commentExample, content: '感谢回复' },
                notes: `${feedSource} ${commentSource}`,
            },
            {
                summary: '回复评论中的某条回复',
                params: {
                    feed: feedExample,
                    comment: commentExample,
                    content: [{ type: 0, content: '我也这么认为' }],
                    reply: replyExample,
                },
                notes: `${feedSource} ${commentSource} reply 使用该评论下的完整回复对象。`,
            },
        ],
        returns: '上游回复结果，包含新回复，保留未知字段。',
        returnsSchema: objectResult,
        params: { feed, comment, content, reply: reply.optional() },
        run: async (p, ctx) =>
            okResponse(
                await ctx.bridge.apis.qzone.replyPublicFeed(p.feed, p.comment, p.content, p.reply),
            ),
    }),
    defineAction({
        name: 'delete_qzone_public_comment',
        summary: '删除推荐动态的一条评论（需有权限）',
        readOnly: false,
        examples: [
            {
                summary: '删除一条评论',
                params: { feed: feedExample, comment: commentExample },
                notes: `${feedSource} ${commentSource}`,
            },
        ],
        returns: '上游删除结果，保留未知字段。',
        returnsSchema: objectResult,
        params: { feed, comment },
        run: async (p, ctx) =>
            okResponse(await ctx.bridge.apis.qzone.deletePublicComment(p.feed, p.comment)),
    }),
    defineAction({
        name: 'delete_qzone_public_reply',
        summary: '删除推荐动态评论下的一条回复（需有权限）',
        readOnly: false,
        examples: [
            {
                summary: '删除一条回复',
                params: { feed: feedExample, comment: commentExample, reply: replyExample },
                notes: `${feedSource} ${commentSource} reply 使用该评论下的完整回复对象。`,
            },
        ],
        returns: '上游删除结果，保留未知字段。',
        returnsSchema: objectResult,
        params: { feed, comment, reply },
        run: async (p, ctx) =>
            okResponse(await ctx.bridge.apis.qzone.deletePublicReply(p.feed, p.comment, p.reply)),
    }),
    defineAction({
        name: 'set_qzone_public_follow',
        summary: '蹲或取消蹲推荐动态作者',
        readOnly: false,
        examples: [
            {
                summary: '蹲这条推荐动态的作者',
                params: { feed: feedExample, enable: true },
                notes: `${feedSource} feed 需保留作者 cell_user_info。`,
            },
        ],
        returns: '上游关系操作结果，保留未知字段。',
        returnsSchema: objectResult,
        params: { feed, enable: f.bool().describe('true 蹲，false 取消蹲').default(true) },
        run: async (p, ctx) =>
            okResponse(await ctx.bridge.apis.qzone.setPublicFollow(p.feed, p.enable)),
    }),
    defineAction({
        name: 'forward_qzone_public_feed',
        summary: '将推荐动态转发到当前账号空间',
        readOnly: false,
        examples: [
            {
                summary: '转发推荐动态到我的空间',
                params: { feed: feedExample, reason: '分享这条动态' },
                notes: `${feedSource} 只转发，不同时评论或发送给 QQ 联系人。`,
            },
        ],
        returns: '上游转发结果，保留未知字段。',
        returnsSchema: objectResult,
        params: { feed, reason: f.string().describe('转发附言，可为空').default('') },
        run: async (p, ctx) =>
            okResponse(await ctx.bridge.apis.qzone.forwardPublicFeed(p.feed, p.reason)),
    }),
];
