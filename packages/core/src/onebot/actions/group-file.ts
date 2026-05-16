import type { ApiHandler, ApiActionContext } from '../api-handler';
import { asBoolean, asNumber, asString } from '../api-handler';
import { RETCODE, failedResponse } from '../types';
import { okResponse } from '../types';

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  h.registerAction('upload_group_file', async (params) => {
    const groupId = asNumber(params.group_id);
    const file = asString(params.file);
    const name = asString(params.name);
    const folderId = asString(params.folder) || asString(params.folder_id) || '/';
    const uploadFile = asBoolean(params.upload_file, true);
    if (!groupId || !file) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and file are required');
    const fileId = await ctx.uploadGroupFile(groupId, file, name, folderId, uploadFile);
    return okResponse({ file_id: fileId });
  });

  h.registerAction('upload_private_file', async (params) => {
    const userId = asNumber(params.user_id);
    const file = asString(params.file);
    const name = asString(params.name);
    const uploadFile = asBoolean(params.upload_file, true);
    if (!userId || !file) return failedResponse(RETCODE.BAD_REQUEST, 'user_id and file are required');
    const fileId = await ctx.uploadPrivateFile(userId, file, name, uploadFile);
    return okResponse({ file_id: fileId });
  });

  h.registerAction('get_group_file_url', async (params) => {
    const groupId = asNumber(params.group_id);
    const fileId = asString(params.file_id);
    const busId = asNumber(params.busid) || 102;
    if (!groupId || !fileId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id and file_id are required');
    }
    return okResponse({ url: await ctx.getGroupFileUrl(groupId, fileId, busId) });
  });

  h.registerAction('get_group_root_files', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    }
    return okResponse(await ctx.getGroupFiles(groupId, '/'));
  });

  h.registerAction('get_group_files_by_folder', async (params) => {
    const groupId = asNumber(params.group_id);
    const folderId = asString(params.folder_id) || asString(params.folder) || '/';
    if (!groupId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    }
    return okResponse(await ctx.getGroupFiles(groupId, folderId));
  });

  h.registerAction('delete_group_file', async (params) => {
    const groupId = asNumber(params.group_id);
    const fileId = asString(params.file_id);
    if (!groupId || !fileId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id and file_id are required');
    }
    await ctx.bridge.deleteGroupFile(groupId, fileId);
    return okResponse();
  });

  h.registerAction('move_group_file', async (params) => {
    const groupId = asNumber(params.group_id);
    const fileId = asString(params.file_id);
    const parentDirectory = asString(params.parent_directory);
    const targetDirectory = asString(params.target_directory);
    if (!groupId || !fileId || !parentDirectory || !targetDirectory) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id, file_id, parent_directory and target_directory are required');
    }
    await ctx.bridge.moveGroupFile(groupId, fileId, parentDirectory, targetDirectory);
    return okResponse();
  });

  h.registerAction('create_group_file_folder', async (params) => {
    const groupId = asNumber(params.group_id);
    const name = asString(params.name);
    const parentId = asString(params.parent_id) || '/';
    if (!groupId || !name) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id and name are required');
    }
    await ctx.createGroupFileFolder(groupId, name, parentId);
    return okResponse();
  });

  h.registerAction('delete_group_file_folder', async (params) => {
    const groupId = asNumber(params.group_id);
    const folderId = asString(params.folder_id);
    if (!groupId || !folderId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id and folder_id are required');
    }
    await ctx.bridge.deleteGroupFileFolder(groupId, folderId);
    return okResponse();
  });

  h.registerAction('rename_group_file_folder', async (params) => {
    const groupId = asNumber(params.group_id);
    const folderId = asString(params.folder_id);
    const newName = asString(params.new_folder_name) || asString(params.name);
    if (!groupId || !folderId || !newName) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id, folder_id and new_folder_name are required');
    }
    await ctx.bridge.renameGroupFileFolder(groupId, folderId, newName);
    return okResponse();
  });

  h.registerAction('get_private_file_url', async (params) => {
    const userId = asNumber(params.user_id);
    const fileId = asString(params.file_id);
    const fileHash = asString(params.file_hash);
    if (!userId || !fileId || !fileHash) {
      return failedResponse(RETCODE.BAD_REQUEST, 'user_id, file_id and file_hash are required');
    }
    return okResponse({ url: await ctx.getPrivateFileUrl(userId, fileId, fileHash) });
  });
}
