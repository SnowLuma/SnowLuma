import type { ApiActionContext, ApiHandler } from '../api-handler';
import { asNumber, asString } from '../api-handler';
import type { JsonValue } from '../types';
import { RETCODE, failedResponse, okResponse } from '../types';

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  h.registerAction('get_group_album_list', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');

    try {
      const albumList = await ctx.bridge.apis.groupAlbum.list(groupId);
      return okResponse(albumList);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to get group album list';
      return failedResponse(RETCODE.INTERNAL_ERROR, message);
    }
  });

  h.registerAction('upload_image_to_qun_album', async (params) => {
    const groupId = asNumber(params.group_id);
    const albumId = asString(params.album_id);
    const albumName = asString(params.album_name);
    const file = asString(params.file);

    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (!albumId) return failedResponse(RETCODE.BAD_REQUEST, 'album_id is required');
    if (!albumName) return failedResponse(RETCODE.BAD_REQUEST, 'album_name is required');
    if (!file) return failedResponse(RETCODE.BAD_REQUEST, 'file is required');

    try {
      await ctx.bridge.apis.groupAlbum.upload(groupId, albumId, albumName, file);
      return okResponse(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to upload image to group album';
      return failedResponse(RETCODE.INTERNAL_ERROR, message);
    }
  });

  h.registerAction('get_group_album_media_list', async (params) => {
    const groupId = asNumber(params.group_id);
    const albumId = asString(params.album_id);
    const attachInfo = asString(params.attach_info) || '';

    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (!albumId) return failedResponse(RETCODE.BAD_REQUEST, 'album_id is required');

    try {
      const mediaList = await ctx.bridge.apis.groupAlbum.getMediaList(groupId, albumId, attachInfo);
      return okResponse(mediaList as unknown as JsonValue);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to get group album media list';
      return failedResponse(RETCODE.INTERNAL_ERROR, message);
    }
  });

  h.registerAction('do_group_album_comment', async (params) => {
    const groupId = asNumber(params.group_id);
    const albumId = asString(params.album_id);
    const lloc = asString(params.lloc);
    const content = asString(params.content);

    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (!albumId) return failedResponse(RETCODE.BAD_REQUEST, 'album_id is required');
    if (!lloc) return failedResponse(RETCODE.BAD_REQUEST, 'lloc is required');
    if (!content) return failedResponse(RETCODE.BAD_REQUEST, 'content is required');

    try {
      const comment = await ctx.bridge.apis.groupAlbum.comment(groupId, albumId, lloc, content);
      return okResponse(comment as unknown as JsonValue);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to comment on album media';
      return failedResponse(RETCODE.INTERNAL_ERROR, message);
    }
  });

  h.registerAction('set_group_album_media_like', async (params) => {
    const groupId = asNumber(params.group_id);
    const albumId = asString(params.album_id);
    const batchId = asString(params.batch_id);
    const lloc = params.lloc ? asString(params.lloc) : undefined; // 可选参数

    if (!groupId || !albumId || !batchId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id, album_id and batch_id are required');
    }

    try {
      const res = await ctx.bridge.apis.groupAlbum.like(groupId, albumId, batchId, lloc, true);
      return okResponse(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to set like on album media';
      return failedResponse(RETCODE.INTERNAL_ERROR, message);
    }
  });

  // 取消点赞群相册媒体
  h.registerAction('cancel_group_album_media_like', async (params) => {
    const groupId = asNumber(params.group_id);
    const albumId = asString(params.album_id);
    const batchId = asString(params.batch_id);
    const lloc = params.lloc ? asString(params.lloc) : undefined; // 可选参数

    if (!groupId || !albumId || !batchId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id, album_id and batch_id are required');
    }

    try {
      const res = await ctx.bridge.apis.groupAlbum.like(groupId, albumId, batchId, lloc, false);
      return okResponse(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to cancel like on album media';
      return failedResponse(RETCODE.INTERNAL_ERROR, message);
    }
  });

  h.registerAction('del_group_album_media', async (params) => {
    const groupId = asNumber(params.group_id);
    const albumId = asString(params.album_id);
    const lloc = asString(params.lloc);

    if (!groupId || !albumId || !lloc) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id, album_id and lloc are required');
    }

    try {
      const res = await ctx.bridge.apis.groupAlbum.delete(groupId, albumId, lloc);
      return okResponse(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to delete album media';
      return failedResponse(RETCODE.INTERNAL_ERROR, message);
    }
  });
}
