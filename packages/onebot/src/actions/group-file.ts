import { defineAction, groupAction, registerActions, f } from '../action-kit';
import type { ApiHandler, ApiActionContext } from '../api-handler';
import { RETCODE, failedResponse, okResponse } from '../types';

// NapCat/LLOneBot omit `busid` from their `get_group_file_url` schema entirely,
// so whatever value a client tacks on is silently ignored. Mirror that here:
// accept any value, coerce when it's a usable non-negative integer, else fall
// back to the canonical 102. Restores the legacy `asNumber(busid) || 102`
// semantics that a strict `f.int({min:0}).default(102)` regressed (a *present*
// non-numeric busid was rejected with `expected an integer`). See issue #147.
function busidOr102(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.trunc(raw)
    : typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))
      ? Math.trunc(Number(raw))
      : NaN;
  return Number.isInteger(n) && n >= 0 ? n : 102;
}

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
    returns: '群文件下载链接。',
    returnsSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '文件下载直链' } },
      required: ['url'],
    },
    // busid is accepted but tolerant (see busidOr102): NapCat/LLBot ignore it,
    // so a present null/empty/non-numeric value must not 400 the request (#147).
    params: { file_id: f.string({ allowEmpty: false }), busid: f.raw() },
    run: async (p, ctx) => {
      return okResponse({ url: await ctx.bridge.apis.groupFile.getUrl(p.group_id, p.file_id, busidOr102(p.busid)) });
    },
  }),

  groupAction({
    name: 'get_group_root_files',
    summary: '获取群根目录文件列表',
    readOnly: true,
    returns: '群文件系统信息（文件与文件夹列表）。',
    returnsSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: '文件列表',
          items: {
            type: 'object',
            properties: {
              group_id: { type: 'integer', description: '群号' },
              file_id: { type: 'string', description: '文件 ID' },
              file_name: { type: 'string', description: '文件名' },
              busid: { type: 'integer', description: '业务 ID' },
              file_size: { type: 'integer', description: '文件大小（字节）' },
              upload_time: { type: 'integer', description: '上传时间戳' },
              dead_time: { type: 'integer', description: '过期时间戳' },
              modify_time: { type: 'integer', description: '修改时间戳' },
              download_times: { type: 'integer', description: '下载次数' },
              uploader: { type: 'integer', description: '上传者 QQ 号' },
              uploader_name: { type: 'string', description: '上传者昵称' },
            },
          },
        },
        folders: {
          type: 'array',
          description: '文件夹列表',
          items: {
            type: 'object',
            properties: {
              group_id: { type: 'integer', description: '群号' },
              folder_id: { type: 'string', description: '文件夹 ID' },
              folder_name: { type: 'string', description: '文件夹名' },
              create_time: { type: 'integer', description: '创建时间戳' },
              creator: { type: 'integer', description: '创建者 QQ 号' },
              create_name: { type: 'string', description: '创建者昵称' },
              total_file_count: { type: 'integer', description: '文件夹内文件总数' },
            },
          },
        },
      },
      required: ['files', 'folders'],
    },
    run: async (p, ctx) => {
      return okResponse(await ctx.getGroupFiles(p.group_id, '/'));
    },
  }),

  groupAction({
    name: 'get_group_files_by_folder',
    summary: '获取群子目录文件列表',
    readOnly: true,
    returns: '群文件系统信息（文件与文件夹列表）。',
    returnsSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: '文件列表',
          items: {
            type: 'object',
            properties: {
              group_id: { type: 'integer', description: '群号' },
              file_id: { type: 'string', description: '文件 ID' },
              file_name: { type: 'string', description: '文件名' },
              busid: { type: 'integer', description: '业务 ID' },
              file_size: { type: 'integer', description: '文件大小（字节）' },
              upload_time: { type: 'integer', description: '上传时间戳' },
              dead_time: { type: 'integer', description: '过期时间戳' },
              modify_time: { type: 'integer', description: '修改时间戳' },
              download_times: { type: 'integer', description: '下载次数' },
              uploader: { type: 'integer', description: '上传者 QQ 号' },
              uploader_name: { type: 'string', description: '上传者昵称' },
            },
          },
        },
        folders: {
          type: 'array',
          description: '文件夹列表',
          items: {
            type: 'object',
            properties: {
              group_id: { type: 'integer', description: '群号' },
              folder_id: { type: 'string', description: '文件夹 ID' },
              folder_name: { type: 'string', description: '文件夹名' },
              create_time: { type: 'integer', description: '创建时间戳' },
              creator: { type: 'integer', description: '创建者 QQ 号' },
              create_name: { type: 'string', description: '创建者昵称' },
              total_file_count: { type: 'integer', description: '文件夹内文件总数' },
            },
          },
        },
      },
      required: ['files', 'folders'],
    },
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

  // rename_group_file — 0x6D6_4。NapCat 入参：file_id + current_parent_directory
  // （文件当前所在目录）+ new_name。SnowLuma 的 file_id 即原始 fileId，无需 UUID 解码。
  groupAction({
    name: 'rename_group_file',
    summary: '重命名群文件',
    params: {
      file_id: f.string({ allowEmpty: false }),
      current_parent_directory: f.string().default('/'),
      new_name: f.string({ allowEmpty: false }),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupFile.rename(p.group_id, p.file_id, p.current_parent_directory || '/', p.new_name);
      // {ok:true} 刻意对齐 NapCat RenameGroupFile 的返回体，偏离 SnowLuma 同类
      // 文件写操作（move/delete 返回空 data）——为 NapCat 客户端 drop-in 兼容。
      return okResponse({ ok: true });
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
    returns: '私聊文件下载链接。',
    returnsSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '文件下载直链' } },
      required: ['url'],
    },
    // NapCat's `get_private_file_url` requires only file_id — it re-derives the
    // file hash by decoding its composite file_id and reading file10MMd5 off the
    // original message. SnowLuma's file_id is the bare fileUUID, so it relies on
    // the file_hash that it already emits alongside file_id in the received file
    // segment (event-converter/to-segment.ts). To stay drop-in for NapCat-style
    // clients that only persist file_id, both user_id and file_hash are now
    // optional; file_hash falls through empty when absent. See issue #147.
    params: {
      user_id: f.uint().optional(),
      file_id: f.string({ allowEmpty: false }),
      file_hash: f.string().default(''),
    },
    run: async (p, ctx) => {
      return okResponse({ url: await ctx.bridge.apis.groupFile.getPrivateUrl(p.user_id ?? 0, p.file_id, p.file_hash) });
    },
  }),
];

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  registerActions(h, ctx, actions);
}
