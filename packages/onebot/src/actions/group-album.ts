import { groupAction, registerActions, f } from '../action-kit';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import type { JsonValue } from '../types';
import { RETCODE, failedResponse, okResponse } from '../types';

export const actions = [
  groupAction({
    name: 'get_group_album_list',
    readOnly: true,
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
