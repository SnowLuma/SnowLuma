import type { JsonObject } from '@snowluma/common/json';
import { RequestUtil, cookieToString, getBknFromCookie } from './request-util';

export type QzonePublicContent = string | JsonObject[];

export interface QzonePublicFeedsPage extends JsonObject {
    feeds: JsonObject[];
    has_more: boolean;
    next_cursor: string | null;
}

interface PublicFeedCursor {
    version: 1;
    uin: string;
    refresh_id: string;
    attach_info: string;
    last_client_feed_union_id: JsonObject | null;
}

const reader = 'trpc.qzone.feeds_reader.FeedsReader';
const interaction = 'trpc.qzone.interaction_writer.InteractionWriter';
const upvote = 'trpc.public_qzone.interaction.UFOComment';
const relation = 'trpc.public_qzone.relation.RelationService';

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function request(
    cookies: Record<string, string>,
    service: string,
    method: string,
    oidb: string,
    params: JsonObject,
): Promise<JsonObject> {
    const [command, serviceType] = oidb.split('_');
    const result = await RequestUtil.HttpGetJson<unknown>(
        `https://h5.qzone.qq.com/http2rpc/gotrpc/v1/${service}/${method}?g_tk=${getBknFromCookie(cookies)}`,
        'POST',
        params,
        {
            Cookie: cookieToString(cookies),
            'Content-Type': 'application/json',
            Referer: 'https://h5.qzone.qq.com/pc-qzone/index.html',
            'x-web-qua': 'V1_HT5_QZ_9.9.32_001_IDC_B',
            'x-oidb': JSON.stringify({
                uint32_command: command,
                uint32_service_type: serviceType,
            }),
        },
    );

    if (!isObject(result) || result.retcode !== 0 || !isObject(result.data)) {
        const code = isObject(result) ? result.retcode : 'invalid response';
        const message =
            isObject(result) && typeof result.message === 'string' ? result.message : '';
        throw new Error(`qzone public ${method} failed: retcode=${code} ${message}`.trim());
    }

    return result.data;
}

function feedParams(feed: JsonObject): JsonObject {
    const common = feed.cell_common;

    if (!isObject(common) || !isObject(common.union_id) || !Object.keys(common.union_id).length) {
        throw new Error('空友动态缺少 cell_common.union_id，请使用推荐列表或详情返回的完整动态');
    }

    return {
        union_id: common.union_id,
        ...(feed.cell_feed_transfer === undefined
            ? {}
            : { cell_feed_transfer: feed.cell_feed_transfer }),
    };
}

function encodeCursor(state: PublicFeedCursor): string {
    const cursor = Buffer.from(JSON.stringify(state)).toString('base64url');

    if (cursor.length > 65_536) {
        throw new Error('空友推荐分页游标过大');
    }

    return cursor;
}

function decodeCursor(cursor: string, uin: string): PublicFeedCursor {
    if (!cursor || cursor.length > 65_536 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new Error('无效的空友推荐 cursor');
    }

    let value: unknown;

    try {
        const bytes = Buffer.from(cursor, 'base64url');

        if (bytes.toString('base64url') !== cursor) {
            throw new Error('non-canonical encoding');
        }

        value = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('无效的空友推荐 cursor');
    }

    if (
        !isObject(value) ||
        value.version !== 1 ||
        value.uin !== uin ||
        typeof value.refresh_id !== 'string' ||
        !value.refresh_id ||
        typeof value.attach_info !== 'string' ||
        !(value.last_client_feed_union_id === null || isObject(value.last_client_feed_union_id))
    ) {
        throw new Error('空友推荐 cursor 无效或不属于当前账号');
    }

    return {
        version: 1,
        uin,
        refresh_id: value.refresh_id,
        attach_info: value.attach_info,
        last_client_feed_union_id: value.last_client_feed_union_id,
    };
}

export async function getQzonePublicCapabilities(
    cookies: Record<string, string>,
    selfUin: string,
): Promise<JsonObject> {
    const data = await request(
        cookies,
        'trpc.public_qzone.entrance_ctrl.EntranceCtrl',
        'BatchEntranceWhitelist',
        '0x9741_0',
        {
            uins: [selfUin],
            entrance_types: [1, 15],
        },
    );
    const result = Array.isArray(data.results)
        ? data.results.find((entry) => isObject(entry) && String(entry.uin) === selfUin)
        : undefined;

    if (!isObject(result) || !isObject(result.entrances)) {
        throw new Error('qzone public BatchEntranceWhitelist 缺少当前账号的 entrances');
    }

    return result.entrances;
}

export async function getQzonePublicFeeds(
    cookies: Record<string, string>,
    selfUin: string,
    cursor?: string,
): Promise<QzonePublicFeedsPage> {
    const state: PublicFeedCursor =
        cursor === undefined
            ? {
                  version: 1,
                  uin: selfUin,
                  refresh_id: `${selfUin}_${Date.now()}`,
                  attach_info: '',
                  last_client_feed_union_id: null,
              }
            : decodeCursor(cursor, selfUin);
    const data = await request(cookies, reader, 'GetPublicRecomFeeds', '0x9a38_0', {
        refresh_id: state.refresh_id,
        ...(cursor === undefined
            ? {}
            : {
                  attach_info: state.attach_info,
                  ...(state.last_client_feed_union_id === null
                      ? {}
                      : { last_client_feed_union_id: state.last_client_feed_union_id }),
              }),
    });

    if (!Array.isArray(data.feeds) || typeof data.has_more !== 'boolean') {
        throw new Error('qzone public GetPublicRecomFeeds 分页响应异常');
    }

    const feeds = data.feeds.map((entry) => {
        if (!isObject(entry) || !isObject(entry.feed)) {
            throw new Error('qzone public GetPublicRecomFeeds 动态响应异常');
        }

        return entry.feed;
    });
    let lastUnion = state.last_client_feed_union_id;

    // The web client carries the last non-ad feed across pages, including ad-only pages.
    for (const feed of feeds) {
        const common = feed.cell_common;

        if (isObject(common) && common.feed_type !== 3 && isObject(common.union_id)) {
            lastUnion = common.union_id;
        }
    }

    let nextCursor: string | null = null;

    if (data.has_more) {
        if (typeof data.attach_info !== 'string') {
            throw new Error('qzone public GetPublicRecomFeeds 缺少 attach_info');
        }

        nextCursor = encodeCursor({
            ...state,
            attach_info: data.attach_info,
            last_client_feed_union_id: lastUnion,
        });
    }

    return { ...data, feeds, has_more: data.has_more, next_cursor: nextCursor };
}

export function getQzonePublicFeedDetail(
    cookies: Record<string, string>,
    feed: JsonObject,
): Promise<JsonObject> {
    return request(cookies, reader, 'GetFeedDetail', '0x97b1_1', {
        ...feedParams(feed),
        feed_action_domain_type: 3,
        from_page: 1,
    });
}

export function getQzonePublicComments(
    cookies: Record<string, string>,
    feed: JsonObject,
    cursor: string,
): Promise<JsonObject> {
    return request(cookies, reader, 'GetComment', '0x9bfd_1', {
        ...feedParams(feed),
        attach_info: cursor,
    });
}

export function getQzonePublicReplies(
    cookies: Record<string, string>,
    feed: JsonObject,
    comment: JsonObject,
    cursor: string,
    pageSize: number,
): Promise<JsonObject> {
    return request(cookies, reader, 'GetReplies', '0x9bfe_1', {
        ...feedParams(feed),
        cur_comment: comment,
        comment_attach_info: '',
        reply_attach_info: cursor || comment.reply_attach_info || '',
        page_size: pageSize,
    });
}

export async function setQzonePublicUpvote(
    cookies: Record<string, string>,
    feed: JsonObject,
    enable: boolean,
): Promise<JsonObject> {
    const data = await request(
        cookies,
        upvote,
        enable ? 'Upvote' : 'Downvote',
        enable ? '0x9d18_1' : '0x9d19_1',
        feedParams(feed),
    );

    if (!data.upvote) {
        throw new Error('qzone public upvote 响应缺少 upvote');
    }

    return data;
}

async function setLike(
    cookies: Record<string, string>,
    feed: JsonObject,
    likeKey: unknown,
    likeType: number,
    enable: boolean,
): Promise<JsonObject> {
    if (typeof likeKey !== 'string' || !likeKey) {
        throw new Error('空友点赞目标缺少 like_key');
    }

    const data = await request(
        cookies,
        interaction,
        enable ? 'DoLike' : 'UnLike',
        enable ? '0x9699_1' : '0x969c_1',
        {
            ...feedParams(feed),
            like_key: likeKey,
            like_type: likeType,
        },
    );

    if (!data.like) {
        throw new Error('qzone public like 响应缺少 like');
    }

    return data;
}

export function setQzonePublicLike(
    cookies: Record<string, string>,
    feed: JsonObject,
    enable: boolean,
): Promise<JsonObject> {
    const common = feed.cell_common;
    return setLike(cookies, feed, isObject(common) ? common.cur_like_key : undefined, 1, enable);
}

export function setQzonePublicCommentLike(
    cookies: Record<string, string>,
    feed: JsonObject,
    comment: JsonObject,
    enable: boolean,
    reply?: JsonObject,
): Promise<JsonObject> {
    const like = (reply ?? comment).like;
    return setLike(cookies, feed, isObject(like) ? like.id : undefined, reply ? 3 : 2, enable);
}

function richContent(content: QzonePublicContent): JsonObject[] {
    return typeof content === 'string' ? [{ type: 0, content }] : content;
}

export async function commentQzonePublicFeed(
    cookies: Record<string, string>,
    feed: JsonObject,
    user: JsonObject,
    content: QzonePublicContent,
): Promise<JsonObject> {
    const data = await request(cookies, interaction, 'AddComment', '0x9676_1', {
        ...feedParams(feed),
        comment: { user, content: richContent(content) },
    });

    if (!data.comment) {
        throw new Error('qzone public AddComment 响应缺少 comment');
    }

    return data;
}

export async function replyQzonePublicFeed(
    cookies: Record<string, string>,
    feed: JsonObject,
    user: JsonObject,
    comment: JsonObject,
    content: QzonePublicContent,
    reply?: JsonObject,
): Promise<JsonObject> {
    const targetUser = reply?.user ?? comment.user;

    if (!isObject(targetUser)) {
        throw new Error('空友评论或回复缺少 user');
    }

    const data = await request(cookies, interaction, 'AddReply', '0x9677_1', {
        ...feedParams(feed),
        comment,
        reply: { content: richContent(content), target_user: targetUser, user },
    });

    if (!data.reply) {
        throw new Error('qzone public AddReply 响应缺少 reply');
    }

    return data;
}

export function deleteQzonePublicComment(
    cookies: Record<string, string>,
    feed: JsonObject,
    comment: JsonObject,
): Promise<JsonObject> {
    return request(cookies, interaction, 'DeleteComment', '0x9989_0', {
        ...feedParams(feed),
        comment,
    });
}

export function deleteQzonePublicReply(
    cookies: Record<string, string>,
    feed: JsonObject,
    comment: JsonObject,
    reply: JsonObject,
): Promise<JsonObject> {
    return request(cookies, interaction, 'DeleteReply', '0x998a_0', {
        ...feedParams(feed),
        comment,
        reply,
    });
}

export async function setQzonePublicFollow(
    cookies: Record<string, string>,
    feed: JsonObject,
    enable: boolean,
): Promise<JsonObject> {
    const params = feedParams(feed);
    const common = feed.cell_common as JsonObject;
    const user = isObject(feed.cell_user_info) ? feed.cell_user_info.user : undefined;
    const uid = isObject(user) && typeof user.uid === 'string' ? user.uid.trim() : '';
    const uin = isObject(user) && typeof user.uin === 'string' ? user.uin.trim() : '';
    const useUid = (common.domain_type === 3 && !!uid) || !uin;

    if (useUid ? !uid : !uin) {
        throw new Error('空友动态缺少作者 uid/uin');
    }

    const union = params.union_id as JsonObject;
    const data = await request(
        cookies,
        relation,
        enable ? 'Follow' : 'Unfollow',
        enable ? '0x9d1a_1' : '0x9d1b_1',
        {
            follow_from_type: 1,
            ...(useUid ? { target_uid: uid } : { target_uin: uin }),
            ...(union.uf_key ? { follow_feed_id: union.uf_key } : {}),
            ...(feed.cell_feed_transfer === undefined
                ? {}
                : { cell_feed_transfer: feed.cell_feed_transfer }),
        },
    );

    if (
        data.ret_code !== undefined &&
        data.ret_code !== null &&
        data.ret_code !== 0 &&
        data.ret_code !== '0'
    ) {
        throw new Error(
            `qzone public follow failed: ret_code=${data.ret_code} ${data.ret_msg ?? ''}`.trim(),
        );
    }

    return data;
}

export function forwardQzonePublicFeed(
    cookies: Record<string, string>,
    feed: JsonObject,
    reason: string,
): Promise<JsonObject> {
    return request(cookies, 'trpc.qzone.feeds_writer.FeedsWriter', 'ForwardFeed', '0x969a_1', {
        ...feedParams(feed),
        reason,
    });
}
