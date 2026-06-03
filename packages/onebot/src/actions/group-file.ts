import { defineAction, groupAction, registerActions, f } from '../action-kit';
import type { ApiHandler, ApiActionContext } from '../api-handler';
import { RETCODE, failedResponse, okResponse } from '../types';

export const actions = [
  groupAction({
    name: 'upload_group_file',
    summary: '上传群文件',
    returns: '{ file_id: string }',
    // `folder` / `folder_id` are two aliases for one target dir; the first
    // non-empty wins, else '/'. Both default '' so the `||` chain matches the
    // legacy `asString(folder) || asString(folder_id) || '/'`.
    params: {
      file: f.string({ allowEmpty: false }),
      name: f.string().default(''),
      folder: f.string().default(''),
      folder_id: f.string().default(''),
      upload_file: f.bool().default(true),
    },
    run: async (p, ctx) => {
      const folderId = p.folder || p.folder_id || '/';
      const result = await ctx.bridge.apis.groupFile.upload(p.group_id, p.file, p.name, folderId, p.upload_file);
      return okResponse({ file_id: result.fileId });
    },
  }),

  defineAction({
    name: 'upload_private_file',
    summary: '上传私聊文件',
    returns: '{ file_id: string }',
    params: {
      user_id: f.uint(),
      file: f.string({ allowEmpty: false }),
      name: f.string().default(''),
      upload_file: f.bool().default(true),
    },
    run: async (p, ctx) => {
      const result = await ctx.bridge.apis.groupFile.uploadPrivate(p.user_id, p.file, p.name, p.upload_file);
      return okResponse({ file_id: result.fileId });
    },
  }),

  groupAction({
    name: 'get_group_file_url',
    summary: '获取群文件下载链接',
    readOnly: true,
    returns: '{ url: string }',
    // busid: legacy `asNumber(busid) || 102` mapped absent/0/invalid → 102.
    // f.int({min:0}).default(102) keeps absent → 102, but a present 0 now
    // stays 0 and a non-numeric busid is now rejected (BAD_REQUEST) instead
    // of silently becoming 102.
    params: { file_id: f.string({ allowEmpty: false }), busid: f.int({ min: 0 }).default(102) },
    run: async (p, ctx) => {
      return okResponse({ url: await ctx.bridge.apis.groupFile.getUrl(p.group_id, p.file_id, p.busid) });
    },
  }),

  groupAction({
    name: 'get_group_root_files',
    summary: '获取群根目录文件列表',
    readOnly: true,
    run: async (p, ctx) => {
      return okResponse(await ctx.getGroupFiles(p.group_id, '/'));
    },
  }),

  groupAction({
    name: 'get_group_files_by_folder',
    summary: '获取群子目录文件列表',
    readOnly: true,
    // folder_id / folder are aliases; first non-empty wins, else '/'.
    params: { folder_id: f.string().default(''), folder: f.string().default('') },
    run: async (p, ctx) => {
      const folderId = p.folder_id || p.folder || '/';
      return okResponse(await ctx.getGroupFiles(p.group_id, folderId));
    },
  }),

  groupAction({
    name: 'delete_group_file',
    summary: '删除群文件',
    params: { file_id: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupFile.delete(p.group_id, p.file_id);
      return okResponse();
    },
  }),

  groupAction({
    name: 'move_group_file',
    summary: '移动群文件',
    params: {
      file_id: f.string({ allowEmpty: false }),
      parent_directory: f.string({ allowEmpty: false }),
      target_directory: f.string({ allowEmpty: false }),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupFile.move(p.group_id, p.file_id, p.parent_directory, p.target_directory);
      return okResponse();
    },
  }),

  groupAction({
    name: 'create_group_file_folder',
    summary: '创建群文件夹',
    params: { name: f.string({ allowEmpty: false }), parent_id: f.string().default('/') },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupFile.createFolder(p.group_id, p.name, p.parent_id || '/');
      return okResponse();
    },
  }),

  groupAction({
    name: 'delete_group_file_folder',
    summary: '删除群文件夹',
    params: { folder_id: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupFile.deleteFolder(p.group_id, p.folder_id);
      return okResponse();
    },
  }),

  groupAction({
    name: 'rename_group_file_folder',
    summary: '重命名群文件夹',
    // new_folder_name / name are aliases; first non-empty wins and must be
    // non-empty (legacy `asString(new_folder_name) || asString(name)` + `!newName`).
    params: { folder_id: f.string({ allowEmpty: false }), new_folder_name: f.string().default(''), name: f.string().default('') },
    run: async (p, ctx) => {
      const newName = p.new_folder_name || p.name;
      if (!newName) {
        return failedResponse(RETCODE.BAD_REQUEST, 'group_id, folder_id and new_folder_name are required');
      }
      await ctx.bridge.apis.groupFile.renameFolder(p.group_id, p.folder_id, newName);
      return okResponse();
    },
  }),

  defineAction({
    name: 'get_private_file_url',
    summary: '获取私聊文件下载链接',
    readOnly: true,
    returns: '{ url: string }',
    params: {
      user_id: f.uint(),
      file_id: f.string({ allowEmpty: false }),
      file_hash: f.string({ allowEmpty: false }),
    },
    run: async (p, ctx) => {
      return okResponse({ url: await ctx.bridge.apis.groupFile.getPrivateUrl(p.user_id, p.file_id, p.file_hash) });
    },
  }),
];

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  registerActions(h, ctx, actions);
}
