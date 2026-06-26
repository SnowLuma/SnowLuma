import { groupAction, registerActions, f } from '../action-kit';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import type { JsonValue } from '../types';
import { RETCODE, failedResponse, okResponse } from '../types';

export const actions = [
  groupAction({
    name: 'get_group_album_list',
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
        },
        required: ['id', 'name', 'picNum', 'createTime'],
      },
    },
    run: async (p, ctx) => {
      try {
        const albumList = await ctx.bridge.apis.groupAlbum.list(p.group_id);
        return okResponse(albumList);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'failed to get group album list';
        return failedResponse(RETCODE.INTERNAL_ERROR, message);
      }
    },
  }),

  // get_qun_album_list — NapCat-named/shaped variant of get_group_album_list.
  // NapCat's own impl calls the kernel AlbumService (trpc, not statically
  // recoverable); we instead reuse the qun_list_album_v2 web API (the same one
  // get_group_album_list uses) and reshape into NapCat's
  // {album_list, attach_info, has_more} envelope. The web endpoint fetches up
  // to 1000 albums in one shot, so attach_info/has_more are ''/false (no cursor
  // pagination); cover_url isn't returned by this endpoint.
  groupAction({
    name: 'get_qun_album_list',
    readOnly: true,
    returns: 'NapCat 风格的相册列表封套：{album_list, attach_info, has_more}（本实现 attach_info 恒为空串、has_more 恒为 false）。',
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
              album_name: { type: 'string', description: '相册名称' },
              create_time: { type: 'integer', description: '相册创建时间（unix 秒）' },
              pic_num: { type: 'integer', description: '相册内照片数量' },
            },
            required: ['album_id', 'album_name', 'create_time', 'pic_num'],
          },
        },
        attach_info: { type: 'string', description: '分页游标（本 web 实现一次取满，恒为空串）' },
        has_more: { type: 'boolean', description: '是否还有更多（本 web 实现恒为 false）' },
      },
      required: ['album_list', 'attach_info', 'has_more'],
    },
    run: async (p, ctx) => {
      try {
        const albumList = await ctx.bridge.apis.groupAlbum.list(p.group_id);
        return okResponse({
          album_list: albumList.map((a) => ({
            album_id: a.id,
            album_name: a.name,
            create_time: a.createTime,
            pic_num: a.picNum,
          })),
          attach_info: '',
          has_more: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'failed to get qun album list';
        return failedResponse(RETCODE.INTERNAL_ERROR, message);
      }
    },
  }),

  groupAction({
    name: 'upload_image_to_qun_album',
    params: {
      album_id: f.string({ allowEmpty: false }),
      album_name: f.string({ allowEmpty: false }),
      file: f.string({ allowEmpty: false }),
    },
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.groupAlbum.upload(p.group_id, p.album_id, p.album_name, p.file);
        return okResponse(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'failed to upload image to group album';
        return failedResponse(RETCODE.INTERNAL_ERROR, message);
      }
    },
  }),

  groupAction({
    name: 'get_group_album_media_list',
    readOnly: true,
    returns: '相册媒体列表及下一页分页游标：{mediaList, nextAttachInfo}。',
    returnsSchema: {
      type: 'object',
      properties: {
        mediaList: {
          type: 'array',
          description: '相册媒体项列表（各项字段不固定）',
          items: { type: 'object' },
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
      try {
        const mediaList = await ctx.bridge.apis.groupAlbum.getMediaList(p.group_id, p.album_id, p.attach_info);
        return okResponse(mediaList as unknown as JsonValue);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'failed to get group album media list';
        return failedResponse(RETCODE.INTERNAL_ERROR, message);
      }
    },
  }),

  groupAction({
    name: 'do_group_album_comment',
    params: {
      album_id: f.string({ allowEmpty: false }),
      lloc: f.string({ allowEmpty: false }),
      content: f.string({ allowEmpty: false }),
    },
    run: async (p, ctx) => {
      try {
        const comment = await ctx.bridge.apis.groupAlbum.comment(p.group_id, p.album_id, p.lloc, p.content);
        return okResponse(comment as unknown as JsonValue);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'failed to comment on album media';
        return failedResponse(RETCODE.INTERNAL_ERROR, message);
      }
    },
  }),

  groupAction({
    name: 'set_group_album_media_like',
    params: {
      album_id: f.string({ allowEmpty: false }),
      batch_id: f.string({ allowEmpty: false }),
      lloc: f.string().optional(), // 可选参数（空串按未传处理）
    },
    run: async (p, ctx) => {
      try {
        const res = await ctx.bridge.apis.groupAlbum.like(p.group_id, p.album_id, p.batch_id, p.lloc || undefined, true);
        return okResponse(res);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'failed to set like on album media';
        return failedResponse(RETCODE.INTERNAL_ERROR, message);
      }
    },
  }),

  // 取消点赞群相册媒体
  groupAction({
    name: 'cancel_group_album_media_like',
    params: {
      album_id: f.string({ allowEmpty: false }),
      batch_id: f.string({ allowEmpty: false }),
      lloc: f.string().optional(), // 可选参数（空串按未传处理）
    },
    run: async (p, ctx) => {
      try {
        const res = await ctx.bridge.apis.groupAlbum.like(p.group_id, p.album_id, p.batch_id, p.lloc || undefined, false);
        return okResponse(res);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'failed to cancel like on album media';
        return failedResponse(RETCODE.INTERNAL_ERROR, message);
      }
    },
  }),

  groupAction({
    name: 'del_group_album_media',
    params: {
      album_id: f.string({ allowEmpty: false }),
      lloc: f.string({ allowEmpty: false }),
    },
    run: async (p, ctx) => {
      try {
        const res = await ctx.bridge.apis.groupAlbum.delete(p.group_id, p.album_id, p.lloc);
        return okResponse(res);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'failed to delete album media';
        return failedResponse(RETCODE.INTERNAL_ERROR, message);
      }
    },
  }),
];

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  registerActions(h, ctx, actions);
}
