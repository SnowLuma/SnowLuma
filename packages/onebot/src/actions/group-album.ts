import { groupAction, f } from '../action-kit';
import type { JsonValue } from '../types';
import { okResponse } from '../types';

const albumCoverUrlSchema = {
    type: ['object', 'null'],
    properties: {
        url: { type: 'string', description: '封面地址' },
        width: { type: 'integer', description: '封面宽度' },
        height: { type: 'integer', description: '封面高度' },
    },
    required: ['url', 'width', 'height'],
};

const albumCoverSchema = {
    type: ['object', 'null'],
    description: '相册封面；没有封面时为 null',
    properties: {
        type: { type: 'integer', description: '封面媒体类型' },
        image: {
            type: ['object', 'null'],
            description: '封面图片信息',
            properties: {
                name: { type: 'string', description: '图片名称' },
                sloc: { type: 'string', description: '图片短定位标识' },
                lloc: { type: 'string', description: '图片长定位标识' },
                photoUrls: {
                    type: 'array',
                    description: '不同规格的封面地址',
                    items: {
                        type: 'object',
                        properties: {
                            spec: { type: 'integer', description: '图片规格' },
                            url: albumCoverUrlSchema,
                        },
                        required: ['spec', 'url'],
                    },
                },
                defaultUrl: albumCoverUrlSchema,
                isGif: { type: 'boolean', description: '是否为动图' },
                hasRaw: { type: 'boolean', description: '是否有原图' },
            },
            required: ['name', 'sloc', 'lloc', 'photoUrls', 'defaultUrl', 'isGif', 'hasRaw'],
        },
    },
    required: ['type', 'image'],
};

// Media-list entries are passed through rather than normalized like covers.
// Missing fields can be absent; decoded undefined values become null.
const mediaUrlSchema = {
    type: ['object', 'null'],
    properties: {
        url: { type: ['string', 'null'] },
        width: { type: ['integer', 'null'] },
        height: { type: ['integer', 'null'] },
    },
};
const mediaPhotoUrlsSchema = {
    type: ['array', 'null'],
    items: {
        type: 'object',
        properties: { spec: { type: ['integer', 'null'] }, url: mediaUrlSchema },
    },
};
const mediaImageSchema = {
    type: ['object', 'null'],
    properties: {
        name: { type: ['string', 'null'] },
        sloc: { type: ['string', 'null'] },
        lloc: { type: ['string', 'null'], description: '图片长定位标识，供评论、删除等操作使用' },
        photoUrls: mediaPhotoUrlsSchema,
        defaultUrl: mediaUrlSchema,
        isGif: { type: ['boolean', 'null'] },
        hasRaw: { type: ['boolean', 'null'] },
    },
};
const albumMediaSchema = {
    type: 'object',
    properties: {
        type: { type: ['integer', 'null'] },
        image: mediaImageSchema,
        video: {
            type: ['object', 'null'],
            properties: {
                id: { type: ['string', 'null'], description: '视频标识，供评论、删除等操作使用' },
                url: { type: ['string', 'null'] },
                cover: mediaImageSchema,
                width: { type: ['integer', 'null'] },
                height: { type: ['integer', 'null'] },
                videoTime: { type: ['string', 'null'], description: '时长，十进制字符串' },
                videoUrl: mediaPhotoUrlsSchema,
            },
        },
        uploader: { type: ['string', 'null'] },
        batchId: { type: ['string', 'null'], description: '上传批次，十进制字符串' },
        uploadTime: { type: ['string', 'null'], description: '上传时间，十进制字符串' },
    },
};

export const actions = [
    groupAction({
        name: 'get_group_album_list',
        examples: [
            {
                summary: '基本调用',
                params: {
                    group_id: 20001,
                },
                notes: '将 group_id 替换为当前账号可访问的群号。',
            },
        ],
        readOnly: true,
        returns: '群相册列表数组，每项为一个相册的基本信息。',
        returnsSchema: {
            type: 'array',
            description: '群相册列表',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '相册 id' },
                    name: { type: 'string', description: '相册名称' },
                    picNum: { type: 'integer', description: '相册内照片数量' },
                    createTime: { type: 'integer', description: '相册创建时间（unix 秒）' },
                    last_upload_time: { type: 'integer', description: '最后上传时间（unix 秒）' },
                    cover: albumCoverSchema,
                    createuin: { type: 'string', description: '相册创建者 QQ 号' },
                    createnickname: {
                        type: 'string',
                        description: '相册创建者昵称（原始 Unicode）',
                    },
                },
                required: [
                    'id',
                    'name',
                    'picNum',
                    'createTime',
                    'last_upload_time',
                    'cover',
                    'createuin',
                    'createnickname',
                ],
            },
        },
        run: async (p, ctx) => {
            const albumList = await ctx.bridge.apis.groupAlbum.list(p.group_id);
            return okResponse(albumList);
        },
    }),

    // get_qun_album_list — NapCat-compatible view of QQ NT's AlbumService.
    groupAction({
        name: 'get_qun_album_list',
        examples: [
            {
                summary: '基本调用',
                params: {
                    group_id: 20001,
                    attach_info: '',
                },
                notes: '后续页原样传回上一页的 attach_info；has_more=false 表示结束。',
            },
        ],
        readOnly: true,
        returns: 'NapCat 风格的相册列表封套：{album_list, attach_info, has_more}。',
        returnsSchema: {
            type: 'object',
            properties: {
                album_list: {
                    type: 'array',
                    description: '相册列表',
                    items: {
                        type: 'object',
                        properties: {
                            album_id: { type: 'string', description: '相册 id' },
                            name: { type: 'string', description: '相册名称' },
                            create_time: { type: 'string', description: '相册创建时间（unix 秒）' },
                            last_upload_time: {
                                type: 'string',
                                description: '最后上传时间（unix 秒）',
                            },
                            upload_number: { type: 'string', description: '相册内媒体数量' },
                            cover: albumCoverSchema,
                            creator: {
                                type: 'object',
                                description: '相册创建者信息',
                                properties: {
                                    uin: { type: 'string', description: '创建者 QQ 号' },
                                    uid: { type: 'string', description: '创建者 UID' },
                                    nick: {
                                        type: 'string',
                                        description: '创建者原始 Unicode 昵称',
                                    },
                                },
                            },
                        },
                        required: [
                            'album_id',
                            'name',
                            'create_time',
                            'last_upload_time',
                            'upload_number',
                            'cover',
                        ],
                    },
                },
                attach_info: { type: 'string', description: '下一页分页游标' },
                has_more: { type: 'boolean', description: '是否还有更多' },
            },
            required: ['album_list', 'attach_info', 'has_more'],
        },
        params: {
            attach_info: f.string().default(''),
        },
        run: async (p, ctx) => {
            const result = await ctx.bridge.apis.groupAlbum.listQun(p.group_id, p.attach_info);
            return okResponse({
                album_list: result.albumList,
                attach_info: result.attachInfo,
                has_more: result.hasMore,
            } as unknown as JsonValue);
        },
    }),

    groupAction({
        name: 'upload_image_to_qun_album',
        examples: [
            {
                summary: '基本调用',
                params: {
                    group_id: 20001,
                    album_id: '<album-id>',
                    album_name: '活动照片',
                    file: 'file:///path/to/photo.png',
                },
                notes: 'album_id 来自 get_group_album_list；lloc 或视频 id、batch_id 来自 get_group_album_media_list。替换群号及对应资源标识。 示例路径位于 SnowLuma 服务端，须替换为该服务可读取的实际文件。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        params: {
            album_id: f.string({ allowEmpty: false }),
            album_name: f.string({ allowEmpty: false }),
            file: f.image(),
        },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAlbum.upload(p.group_id, p.album_id, p.album_name, p.file);
            return okResponse(null);
        },
    }),

    groupAction({
        name: 'upload_video_to_qun_album',
        examples: [
            {
                summary: '上传视频到群相册',
                params: {
                    group_id: 20001,
                    album_id: '<album-id>',
                    album_name: '活动视频',
                    file: 'file:///path/to/video.mp4',
                },
                notes: 'album_id 来自 get_group_album_list；lloc 或视频 id、batch_id 来自 get_group_album_media_list。替换群号及对应资源标识。 示例路径位于 SnowLuma 服务端，须替换为该服务可读取的实际文件。',
            },
        ],
        summary: '上传视频到群相册',
        returns: '{ id: string }',
        returnsSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '视频 id' },
            },
            required: ['id'],
        },
        params: {
            album_id: f.string({ allowEmpty: false }).describe('相册 id'),
            album_name: f.string({ allowEmpty: false }).describe('相册名称'),
            file: f.video().describe('视频文件'),
        },
        run: async (p, ctx) => {
            const result = await ctx.bridge.apis.groupAlbum.uploadVideo(
                p.group_id,
                p.album_id,
                p.album_name,
                p.file,
            );
            return okResponse(result);
        },
    }),

    groupAction({
        name: 'get_group_album_media_list',
        examples: [
            {
                summary: '基本调用',
                params: {
                    group_id: 20001,
                    album_id: '<album-id>',
                    attach_info: '',
                },
                notes: 'album_id 来自 get_group_album_list；lloc 或视频 id、batch_id 来自 get_group_album_media_list。替换群号及对应资源标识。 下一页传回 nextAttachInfo。',
            },
        ],
        readOnly: true,
        returns:
            '相册图片/视频列表及下一页分页游标；视频项包含 id、url、cover、尺寸、时长和多规格地址。',
        returnsSchema: {
            type: 'object',
            properties: {
                mediaList: {
                    type: 'array',
                    description: '相册图片或视频，未返回的字段可省略或为 null',
                    items: albumMediaSchema,
                },
                nextAttachInfo: { type: 'string', description: '下一页分页游标（空串表示无更多）' },
            },
            required: ['mediaList', 'nextAttachInfo'],
        },
        params: {
            album_id: f.string({ allowEmpty: false }),
            attach_info: f.string().default(''),
        },
        run: async (p, ctx) => {
            const mediaList = await ctx.bridge.apis.groupAlbum.getMediaList(
                p.group_id,
                p.album_id,
                p.attach_info,
            );
            return okResponse(mediaList as unknown as JsonValue);
        },
    }),

    groupAction({
        name: 'do_group_album_comment',
        examples: [
            {
                summary: '基本调用',
                params: {
                    group_id: 20001,
                    album_id: '<album-id>',
                    lloc: '<media-lloc-or-video-id>',
                    content: '拍得很好',
                },
                notes: 'album_id 来自 get_group_album_list；lloc 或视频 id、batch_id 来自 get_group_album_media_list。替换群号及对应资源标识。',
            },
        ],
        returnsSchema: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                },
                user: {
                    type: 'object',
                    properties: {
                        uin: {
                            type: 'string',
                        },
                    },
                    required: ['uin'],
                },
                content: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            type: {
                                type: 'integer',
                            },
                            content: {
                                type: 'string',
                            },
                        },
                        required: ['type', 'content'],
                    },
                },
                time: {
                    type: 'string',
                    description: '十进制时间字符串',
                },
                clientKey: {
                    type: 'string',
                },
            },
            required: ['id', 'user', 'content', 'time', 'clientKey'],
        },
        params: {
            album_id: f.string({ allowEmpty: false }),
            lloc: f.string({ allowEmpty: false }),
            content: f.string({ allowEmpty: false }),
        },
        run: async (p, ctx) => {
            const comment = await ctx.bridge.apis.groupAlbum.comment(
                p.group_id,
                p.album_id,
                p.lloc,
                p.content,
            );
            return okResponse(comment as unknown as JsonValue);
        },
    }),

    groupAction({
        name: 'set_group_album_media_like',
        examples: [
            {
                summary: '基本调用',
                params: {
                    group_id: 20001,
                    album_id: '<album-id>',
                    batch_id: '1700000000',
                },
                notes: 'album_id 来自 get_group_album_list；lloc 或视频 id、batch_id 来自 get_group_album_media_list。替换群号及对应资源标识。 batch_id 必须是实际批次的十进制字符串。',
            },
        ],
        returnsSchema: {
            type: 'object',
            properties: {
                id: {
                    type: ['string', 'null'],
                },
                status: {
                    type: ['integer', 'null'],
                },
            },
        },
        params: {
            album_id: f.string({ allowEmpty: false }),
            batch_id: f.string({ allowEmpty: false }),
            lloc: f.string().optional(), // 可选参数（空串按未传处理）
        },
        run: async (p, ctx) => {
            const res = await ctx.bridge.apis.groupAlbum.like(
                p.group_id,
                p.album_id,
                p.batch_id,
                p.lloc || undefined,
                true,
            );
            return okResponse(res);
        },
    }),

    // 取消点赞群相册媒体
    groupAction({
        name: 'cancel_group_album_media_like',
        examples: [
            {
                summary: '基本调用',
                params: {
                    group_id: 20001,
                    album_id: '<album-id>',
                    batch_id: '1700000000',
                },
                notes: 'album_id 来自 get_group_album_list；lloc 或视频 id、batch_id 来自 get_group_album_media_list。替换群号及对应资源标识。 batch_id 必须是实际批次的十进制字符串。',
            },
        ],
        returnsSchema: {
            type: 'object',
            properties: {
                id: {
                    type: ['string', 'null'],
                },
                status: {
                    type: ['integer', 'null'],
                },
            },
        },
        params: {
            album_id: f.string({ allowEmpty: false }),
            batch_id: f.string({ allowEmpty: false }),
            lloc: f.string().optional(), // 可选参数（空串按未传处理）
        },
        run: async (p, ctx) => {
            const res = await ctx.bridge.apis.groupAlbum.like(
                p.group_id,
                p.album_id,
                p.batch_id,
                p.lloc || undefined,
                false,
            );
            return okResponse(res);
        },
    }),

    groupAction({
        name: 'del_group_album_media',
        examples: [
            {
                summary: '删除群相册图片或视频',
                params: {
                    group_id: 20001,
                    album_id: '<album-id>',
                    lloc: '<media-lloc-or-video-id>',
                },
                notes: 'album_id 来自 get_group_album_list；lloc 或视频 id、batch_id 来自 get_group_album_media_list。替换群号及对应资源标识。',
            },
        ],
        returnsSchema: {
            type: 'object',
            properties: {
                success: {
                    const: true,
                },
            },
            required: ['success'],
        },
        summary: '删除群相册图片或视频',
        params: {
            album_id: f.string({ allowEmpty: false }),
            lloc: f.string({ allowEmpty: false }).describe('图片长定位标识，或视频 id'),
        },
        run: async (p, ctx) => {
            const res = await ctx.bridge.apis.groupAlbum.delete(p.group_id, p.album_id, p.lloc);
            return okResponse(res);
        },
    }),
];
