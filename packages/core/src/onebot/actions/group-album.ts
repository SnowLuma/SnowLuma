import type { ApiHandler, ApiActionContext } from '../api-handler';
import { asNumber, asString } from '../api-handler';
import { RETCODE, failedResponse, okResponse } from '../types';

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  h.registerAction('get_group_album_list', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');

    try {
      const albumList = await ctx.getGroupAlbumList(groupId);
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
      await ctx.uploadImageToGroupAlbum(groupId, albumId, albumName, file);
      return okResponse(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to upload image to group album';
      return failedResponse(RETCODE.INTERNAL_ERROR, message);
    }
  });

  h.registerAction('get_group_album_media_list', async (params) => {
    const groupId = asNumber(params.group_id);
    const albumId = asString(params.album_id);

    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (!albumId) return failedResponse(RETCODE.BAD_REQUEST, 'album_id is required');

    try {
      const mediaList = await ctx.getGroupAlbumMediaList(groupId, albumId);
      return okResponse(mediaList);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to get group album media list';
      return failedResponse(RETCODE.INTERNAL_ERROR, message);
    }
  });
}
