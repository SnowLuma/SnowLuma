import { readFile } from 'node:fs/promises';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import { asNumber, asString } from '../api-handler';
import type { ForwardPreviewMeta } from '../modules/message-actions';
import { JsonObject, RETCODE, failedResponse, okResponse } from '../types';
import { defineAction, groupAction, groupUserAction, registerActions, f } from '../action-kit';

const DOWNLOAD_FILE_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB
const DOWNLOAD_FILE_TIMEOUT_MS = 60_000;

async function fetchDownloadFile(
  url: string,
  headers: Record<string, string>,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`download too large: ${declared} > ${maxBytes}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new Error(`download too large: ${bytes.length} > ${maxBytes}`);
    }
    return bytes;
  }
  // 流式读取，防止服务器 Content-Length 导致内存占用过大 — 一旦累计字节数超过上限就中止读取。
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => { /* ignore */ });
        throw new Error(`download too large: > ${maxBytes}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

// 把下载好的字节落盘到 data/downloads。<preferredName> 缺省时用内容 md5 命名。
// basename + relative 检查拦截目录穿越：名称里的路径分隔符被剥成纯文件名，
// 再确认解析后仍在 downloads 目录下，避免 ../ 逃逸。
async function saveDownloadBuffer(buf: Buffer, preferredName: string): Promise<string> {
  const fs = await import('fs');
  const pathMod = await import('path');
  const cryptoMod = await import('crypto');
  const tempDir = pathMod.resolve('data', 'downloads');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const rawName = preferredName || cryptoMod.createHash('md5').update(buf).digest('hex');
  const safeName = pathMod.basename(rawName);
  if (!safeName || safeName === '.' || safeName === '..' || /[\\/]/.test(safeName)) {
    throw new Error('invalid file name');
  }
  const resolved = pathMod.resolve(tempDir, safeName);
  const rel = pathMod.relative(tempDir, resolved);
  if (rel.startsWith('..') || pathMod.isAbsolute(rel)) {
    throw new Error('invalid file name');
  }
  await fs.promises.writeFile(resolved, buf);
  return resolved;
}

// 从 send_*_forward_msg 的参数里提取 NapCat 兼容的转发预览元信息。四个字段都是可选的——如果没有提供，模块层会根据实际消息节点列表推断出合理的默认值。
function readForwardPreviewMeta(params: Record<string, unknown>): ForwardPreviewMeta | undefined {
  const source = asString(params.source) || undefined;
  const summary = asString(params.summary) || undefined;
  const prompt = asString(params.prompt) || undefined;
  let news: Array<{ text: string }> | undefined;
  if (Array.isArray(params.news)) {
    const collected: Array<{ text: string }> = [];
    for (const item of params.news) {
      if (typeof item === 'string') {
        collected.push({ text: item });
      } else if (item && typeof item === 'object' && !Array.isArray(item)) {
        const text = asString((item as Record<string, unknown>).text);
        if (text) collected.push({ text });
      }
    }
    if (collected.length > 0) news = collected;
  }
  if (!source && !summary && !prompt && !news) return undefined;
  return { source, summary, prompt, news };
}

// 群待办三动作（set/complete/cancel）共享：按 message_id 查消息元数据 → 校验归属 → 执行 op。
async function groupTodoRun(
  p: { group_id: number; message_id: number },
  ctx: ApiActionContext,
  op: (groupId: number, msgSeq: bigint) => Promise<void>,
) {
  const meta = ctx.getMessageMeta(p.message_id);
  if (!meta) return failedResponse(RETCODE.ACTION_FAILED, 'message not found');
  if (!meta.isGroup || meta.targetId !== p.group_id) {
    return failedResponse(RETCODE.ACTION_FAILED, 'message does not belong to this group');
  }
  try {
    await op(p.group_id, BigInt(meta.sequence));
    return okResponse();
  } catch (err) {
    return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
  }
}

/** FlashTransferApi 返回的 FlashFileInfo → OneBot JSON 响应（plain object，JsonObject 兼容）。
 *  字段名对齐 NapCat（get_flash_file_list 用 size，非 file_size），便于客户端 drop-in 迁移。 */
function flashFileInfoToJson(f: {
  filesetUuid: string; fileName: string; origName: string; fileSize: number;
  shareUrl: string; fileId: string; downloadUrl: string;
}): JsonObject {
  return {
    fileset_id: f.filesetUuid,
    file_name: f.fileName,
    orig_name: f.origName,
    size: f.fileSize,
    share_url: f.shareUrl,
    file_id: f.fileId,
    download_url: f.downloadUrl,
  };
}

export const actions = [
  // 赞
  defineAction({
    name: 'send_like',
    summary: '点赞',
    params: {
      user_id: f.uint(),
      // 原实现用 `asNumber(times) || 1`，present 0 会被当作缺省 1。
      times: f.int({ min: 0 }).default(1),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.interaction.sendLike(p.user_id, p.times);
      return okResponse();
    },
  }),
  // 拍一拍
  defineAction({
    name: 'friend_poke',
    summary: '好友拍一拍',
    params: {
      user_id: f.uint(),
      target_id: f.uint().optional(),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.interaction.sendPoke(false, p.user_id, p.target_id);
      return okResponse();
    },
  }),

  groupUserAction({
    name: 'group_poke',
    summary: '群拍一拍',
    run: async (p, ctx) => {
      await ctx.bridge.apis.interaction.sendPoke(true, p.group_id, p.user_id);
      return okResponse();
    },
  }),

  defineAction({
    name: 'send_poke',
    summary: '拍一拍（群聊/私聊自动路由）',
    params: {
      user_id: f.uint(),
      group_id: f.uint().optional(),
    },
    run: async (p, ctx) => {
      if (p.group_id) {
        await ctx.bridge.apis.interaction.sendPoke(true, p.group_id, p.user_id);
      } else {
        await ctx.bridge.apis.interaction.sendPoke(false, p.user_id);
      }
      return okResponse();
    },
  }),

  // 精华消息
  defineAction({
    name: 'set_essence_msg',
    summary: '设置精华消息',
    params: { message_id: f.messageId() },
    run: async (p, ctx) => {
      await ctx.setEssenceMsg(p.message_id);
      return okResponse();
    },
  }),

  defineAction({
    name: 'delete_essence_msg',
    summary: '移除精华消息',
    params: { message_id: f.messageId() },
    run: async (p, ctx) => {
      await ctx.deleteEssenceMsg(p.message_id);
      return okResponse();
    },
  }),

  groupAction({
    name: 'get_essence_msg_list',
    summary: '获取精华消息列表',
    readOnly: true,
    run: async (p, ctx) => {
      try {
        const essenceDataAll = await ctx.bridge.apis.web.getEssenceAll(p.group_id);

        const allMsgs = essenceDataAll.flatMap((res) => res.data?.msg_list || []);

        return okResponse(allMsgs);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, `获取精华消息失败: ${e}`);
      }
    },
  }),

  // 群聊表情回应
  defineAction({
    name: 'set_group_reaction',
    summary: '群聊表情回应',
    params: {
      group_id: f.uint().optional(),
      message_id: f.messageId(),
      code: f.string({ allowEmpty: false }),
      is_set: f.bool().default(true),
    },
    run: async (p, ctx) => {
      const meta = ctx.getMessageMeta(p.message_id);
      if (!meta || !meta.isGroup) {
        return failedResponse(RETCODE.ACTION_FAILED, 'message not found or not a group message');
      }

      if (p.group_id && p.group_id !== meta.targetId) {
        return failedResponse(RETCODE.BAD_REQUEST, 'group_id does not match message session');
      }

      await ctx.bridge.apis.interaction.setReaction(meta.targetId, meta.sequence, p.code, p.is_set);
      return okResponse();
    },
  }),

  // 删除收藏表情（Faceroam.OpReq opType=2）
  defineAction({
    name: 'delete_custom_face',
    summary: '删除收藏表情',
    params: { emoji_id: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.profile.deleteCustomFace(p.emoji_id);
        return okResponse();
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  // 添加收藏表情（ImgStore.BDHExpressionRoam + highway HTTP 上传）
  defineAction({
    name: 'add_custom_face',
    summary: '添加收藏表情',
    params: { file: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      try {
        const emojiId = await ctx.bridge.apis.profile.addCustomFace(p.file);
        return okResponse({ emoji_id: emojiId });
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  // 修改收藏表情备注（OIDB 0x902e_1 opType=3）
  defineAction({
    name: 'modify_custom_face',
    summary: '修改收藏表情备注',
    params: {
      emoji_id: f.string({ allowEmpty: false }),
      desc: f.string().default(''),
    },
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.profile.modifyCustomFace(p.emoji_id, p.desc);
        return okResponse();
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  // 收藏表情排序（OIDB 0x902f + 0x902e opType=2 两步）。把 emoji_id 移到
  // position 位置（1=最前）。move_to_front 是 position=1 的语法糖。
  // 收藏表情移到最前（OIDB 0x902f + 0x902e opType=2 两步）。QQ 客户端只有
  // "移动到最前"操作，协议层也只支持最前——0x902f 的 f3=1 是固定标志，不是
  // 位置变量，移到其他位置服务端不生效。所以这个 action 只做"移到最前"。
  defineAction({
    name: 'move_custom_face_to_front',
    summary: '收藏表情移到最前',
    params: { emoji_id: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.profile.moveCustomFaceToFront(p.emoji_id);
        return okResponse();
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  // 消息历史
  groupAction({
    name: 'get_group_msg_history',
    summary: '获取群消息历史',
    readOnly: true,
    params: {
      // message_id is a signed int32 hash (hashMessageIdInt32) and is
      // frequently NEGATIVE — a `{min:0}` validator rejects a real anchor at
      // param-validation time (retcode 1400) before run() ever fires. Use a
      // plain signed int; `.default(0)` keeps absent/present-0 → "fetch latest"
      // (matches the original `asNumber(message_id) || 0`). `count` stays ≥0.
      message_id: f.int().default(0),
      count: f.int({ min: 0 }).default(20),
    },
    run: async (p, ctx) => {
      const messages = await ctx.getGroupMsgHistory(p.group_id, p.message_id, p.count);
      return okResponse({ messages });
    },
  }),

  defineAction({
    name: 'get_friend_msg_history',
    summary: '获取好友消息历史',
    readOnly: true,
    params: {
      user_id: f.uint(),
      // Signed int32 hash, frequently negative — see get_group_msg_history.
      message_id: f.int().default(0),
      count: f.int({ min: 0 }).default(20),
    },
    run: async (p, ctx) => {
      const messages = await ctx.getFriendMsgHistory(p.user_id, p.message_id, p.count);
      return okResponse({ messages });
    },
  }),

  // 标记消息已读
  defineAction({
    name: 'mark_group_msg_as_read',
    summary: '标记群消息已读',
    params: {
      message_id: f.messageId(),
      group_id: f.uint().optional(),
    },
    run: async (p, ctx) => {
      const meta = ctx.getMessageMeta(p.message_id);
      if (!meta || !meta.isGroup) {
        return failedResponse(RETCODE.ACTION_FAILED, 'message not found or not a group message');
      }

      if (p.group_id && p.group_id !== meta.targetId) {
        return failedResponse(RETCODE.BAD_REQUEST, 'group_id does not match message session');
      }

      await ctx.bridge.apis.message.markGroupRead(meta.targetId, meta.sequence);
      return okResponse();
    },
  }),

  defineAction({
    name: 'mark_private_msg_as_read',
    summary: '标记私聊消息已读',
    params: {
      message_id: f.messageId(),
      user_id: f.uint().optional(),
    },
    run: async (p, ctx) => {
      const meta = ctx.getMessageMeta(p.message_id);
      if (!meta || meta.isGroup) {
        return failedResponse(RETCODE.ACTION_FAILED, 'message not found or not a private message');
      }

      if (p.user_id && p.user_id !== meta.targetId) {
        return failedResponse(RETCODE.BAD_REQUEST, 'user_id does not match message session');
      }

      await ctx.bridge.apis.message.markPrivateRead(meta.targetId, meta.sequence);
      return okResponse();
    },
  }),

  defineAction({
    name: 'mark_msg_as_read',
    summary: '标记消息已读（群聊/私聊自动路由）',
    params: {
      message_id: f.messageId(),
      target_id: f.uint().optional(),
    },
    run: async (p, ctx) => {
      const meta = ctx.getMessageMeta(p.message_id);
      if (!meta) return failedResponse(RETCODE.ACTION_FAILED, 'message not found');

      if (p.target_id && p.target_id !== meta.targetId) {
        return failedResponse(RETCODE.BAD_REQUEST, 'target_id does not match message session');
      }

      if (meta.isGroup) {
        await ctx.bridge.apis.message.markGroupRead(meta.targetId, meta.sequence);
      } else {
        await ctx.bridge.apis.message.markPrivateRead(meta.targetId, meta.sequence);
      }
      return okResponse();
    },
  }),

  // 群公告
  groupAction({
    name: '_send_group_notice',
    summary: '发送群公告',
    params: {
      content: f.string({ allowEmpty: false }),
      image: f.string().default(''),
      pinned: f.raw(),
      type: f.raw(),
      confirm_required: f.raw(),
    },
    run: async (p, ctx) => {
      try {
        const options = {
          image: p.image || undefined,
          pinned: p.pinned !== undefined ? Number(p.pinned) : 0,
          type: p.type !== undefined ? Number(p.type) : 1,
          confirm_required: p.confirm_required !== undefined ? Number(p.confirm_required) : 1,
        };

        await ctx.bridge.apis.web.sendNotice(p.group_id, p.content, options);
        return okResponse();
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  groupAction({
    name: '_get_group_notice',
    summary: '获取群公告',
    readOnly: true,
    run: async (p, ctx) => {
      try {
        const notices = await ctx.bridge.apis.web.getNotice(p.group_id);
        return okResponse(notices);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  // 转发消息。messages/message 互为别名键，两者皆缺省视为未提供。
  defineAction({
    name: 'upload_forward_msg',
    summary: '上传转发消息',
    params: {
      messages: f.message().optional(),
      message: f.message().optional(),
      group_id: f.uint().optional(),
    },
    run: async (p, ctx) => {
      const messages = p.messages ?? p.message;
      const groupId = p.group_id ?? 0;
      if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');
      // 群聊和私聊转发消息的 resId 是分开的（前者是 type=3+groupUin，后者是 type=1+selfUid），
      const result = await ctx.sendForwardMsg(messages, groupId > 0 ? groupId : undefined);
      const data: Record<string, unknown> = {
        res_id: result.forwardId,
        forward_id: result.forwardId,
        message_id: 0,
      };
      if (groupId > 0) data.group_id = groupId;
      return okResponse(data as import('../types').JsonObject);
    },
  }),

  defineAction({
    name: 'upload_foward_msg',
    summary: '上传转发消息（别名拼写）',
    params: {
      messages: f.message().optional(),
      message: f.message().optional(),
      group_id: f.uint().optional(),
    },
    run: async (p, ctx) => {
      const messages = p.messages ?? p.message;
      const groupId = p.group_id ?? 0;
      if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');
      const result = await ctx.sendForwardMsg(messages, groupId > 0 ? groupId : undefined);
      return okResponse({ res_id: result.forwardId, forward_id: result.forwardId, message_id: 0 });
    },
  }),

  // 文件信息
  defineAction({
    name: 'get_image',
    summary: '获取图片信息',
    readOnly: true,
    params: {
      file: f.string().default(''),
      file_id: f.string().default(''),
    },
    run: async (p, ctx) => {
      const file = p.file || p.file_id;
      if (!file) return failedResponse(RETCODE.BAD_REQUEST, 'file is required');
      const info = await ctx.getImageInfo(file);
      if (info) return okResponse(info);
      return failedResponse(RETCODE.ACTION_FAILED, 'image not found in cache');
    },
  }),

  defineAction({
    name: 'get_record',
    summary: '获取语音信息',
    readOnly: true,
    params: {
      file: f.string().default(''),
      file_id: f.string().default(''),
    },
    run: async (p, ctx) => {
      const file = p.file || p.file_id;
      if (!file) return failedResponse(RETCODE.BAD_REQUEST, 'file is required');
      const info = await ctx.getRecordInfo(file);
      if (info) return okResponse(info);
      return failedResponse(RETCODE.ACTION_FAILED, 'record not found in cache');
    },
  }),

  defineAction({
    // Primary name matches NapCat for drop-in migration; the rest are aliases.
    name: ['fetch_ptt_text', 'get_ptt_text', 'get_record_text'],
    summary: '获取语音转文字结果',
    readOnly: true,
    params: {
      message_id: f.string().default(''),
    },
    // `raw` so message_id works whether the client sends a number or a string.
    run: async (_p, ctx, raw) => {
      const messageId = asNumber(raw.message_id);
      if (!messageId) return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
      try {
        return okResponse(await ctx.fetchPttText(messageId));
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, e instanceof Error ? e.message : '获取语音转文字结果失败');
      }
    },
  }),

  // Cookie、CSRF 令牌和账号信息
  defineAction({
    name: 'get_cookies',
    summary: '获取 Cookies',
    readOnly: true,
    params: { domain: f.string().default('qun.qq.com') },
    run: async (p, ctx) => {
      try {
        const cookies = await ctx.bridge.apis.web.getCookiesStr(p.domain || 'qun.qq.com');
        return okResponse({ cookies });
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'get_csrf_token',
    summary: '获取 CSRF 令牌',
    readOnly: true,
    params: {},
    run: async (_p, ctx) => {
      try {
        const token = await ctx.bridge.apis.web.getCsrfToken();
        return okResponse({ token });
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'get_credentials',
    summary: '获取凭证',
    readOnly: true,
    params: { domain: f.string().default('qun.qq.com') },
    run: async (p, ctx) => {
      try {
        const creds = await ctx.bridge.apis.web.getCredentials(p.domain || 'qun.qq.com');
        return okResponse(creds);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  // 重启和清理缓存
  defineAction({
    name: 'set_restart',
    summary: '重启（不支持）',
    params: {},
    run: async () => {
      return failedResponse(RETCODE.ACTION_FAILED, 'not supported');
    },
  }),

  defineAction({
    name: 'clean_cache',
    summary: '清理缓存',
    params: {},
    run: async () => {
      return okResponse();
    },
  }),

  // 以下接口在方便用户迁移和兼容现有的 OneBot/NapCat 客户端。
  defineAction({
    name: 'set_friend_remark',
    summary: '设置好友备注',
    params: {
      user_id: f.uint(),
      remark: f.string(),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.friend.setRemark(p.user_id, p.remark);
      return okResponse();
    },
  }),

  defineAction({
    name: 'set_group_remark',
    summary: '设置群备注',
    params: {
      group_id: f.uint(),
      remark: f.string(),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.setRemark(p.group_id, p.remark);
      return okResponse();
    },
  }),

  defineAction({
    name: 'set_msg_emoji_like',
    summary: '设置消息表情回应',
    params: {
      message_id: f.messageId(),
      emoji_id: f.string({ allowEmpty: false }),
      set: f.bool().default(true),
    },
    run: async (p, ctx) => {
      await ctx.setMsgEmojiLike(p.message_id, p.emoji_id, p.set);
      return okResponse();
    },
  }),

  // _mark_all_as_read — no-op。NapCat 靠单次内核 IPC markAllMsgAsRead() 实现，
  // SnowLuma 无等价单包 SSO cmd；遍历所有会话逐个发已读报告是风控高危群发，
  // 故暂不真正执行（留待 RE 出"一键全读"cmd）。返回 ok 以兼容启动时盲调的客户端。
  defineAction({
    name: '_mark_all_as_read',
    summary: '标记全部已读（no-op，待 RE 全读 cmd）',
    params: {},
    run: async () => {
      return okResponse();
    },
  }),

  groupAction({
    name: 'get_group_file_system_info',
    summary: '获取群文件系统信息',
    readOnly: true,
    run: async (p, ctx) => {
      const info = await ctx.bridge.apis.groupFile.getCount(p.group_id);
      return okResponse({
        file_count: info.fileCount,
        limit_count: info.maxCount,
        used_space: 0,
        total_space: 10737418240,
      });
    },
  }),

  defineAction({
    name: 'check_url_safely',
    summary: '检查链接安全性',
    readOnly: true,
    params: {},
    run: async () => {
      return okResponse({ level: 1 });
    },
  }),

  defineAction({
    name: 'set_qq_profile',
    summary: '设置 QQ 资料',
    params: {
      nickname: f.string().optional(),
      personal_note: f.string().optional(),
    },
    run: async (p, ctx) => {
      const nickname = p.nickname;
      const personalNote = p.personal_note;

      try {
        await ctx.bridge.apis.profile.setProfile(nickname, personalNote);
        return okResponse();
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'set_online_status',
    summary: '设置在线状态',
    params: {
      // 原实现用 asNumber+`status===0` 拒绝，等价于必填非零整数。
      status: f.int({ nonZero: true }),
      ext_status: f.int({ min: 0 }).default(0),
      battery_status: f.int({ min: 0 }).default(100),
    },
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.profile.setOnlineStatus(p.status, p.ext_status, p.battery_status);
        return okResponse();
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  // 自定义在线状态：与 set_online_status 使用相同的网络包。
  // 这里只填充 customExt 子消息，并将 status/extStatus 强制设为 QQ 定义的“我有自定义状态”取值（10 / 2000）。
  // face_id 和 face_type 可接受数字或数字字符串，以兼容 NapCat；wording 是图标旁展示的可读文本。
  defineAction({
    name: 'set_diy_online_status',
    summary: '设置自定义在线状态',
    params: {
      face_id: f.uint(),
      // 原实现用 `asNumber(face_type) || 1`，present 0 会被当作缺省 1。
      face_type: f.int({ min: 0 }).default(1),
      wording: f.string().default(''),
    },
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.profile.setDiyOnlineStatus(p.face_id, p.wording, p.face_type);
        return okResponse();
      } catch (err) {
        return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
      }
    },
  }),

  defineAction({
    name: 'get_group_ignored_notifies',
    summary: '获取被过滤的入群请求',
    readOnly: true,
    params: {},
    run: async (_p, ctx) => {
      const reqs = await fetchFilteredGroupRequests(ctx);
      return okResponse(reqs.map((r) => ({
        group_id: r.groupId,
        group_name: r.groupName,
        request_id: r.sequence,
        requester_uin: r.targetUin,
        requester_nick: r.targetName,
        message: r.comment,
        checked: r.state !== 1,
        actor: r.operatorUin,
        invitor_uin: r.invitorUin,
        invitor_nick: r.invitorName,
        flag: `${r.eventType}:${r.groupId}:${r.targetUid}:filtered`,
      })));
    },
  }),

  // NapCat 对“被忽略通知中属于入群请求的子集”的命名（notify type == 7）。
  // 这里把经过过滤的 0x10c8_2 每一项映射成 NapCat 结构。
  // eventType 已经在当前流水线中编码了请求类别。
  defineAction({
    name: 'get_group_ignore_add_request',
    summary: '获取被忽略的入群请求（NapCat）',
    readOnly: true,
    params: {},
    run: async (_p, ctx) => {
      const reqs = await fetchFilteredGroupRequests(ctx);
      return okResponse(reqs.map((r) => ({
        request_id: r.sequence,
        invitor_uin: r.invitorUin,
        invitor_nick: r.invitorName,
        group_id: r.groupId,
        message: r.comment,
        group_name: r.groupName,
        checked: r.state !== 1,
        actor: r.operatorUin,
        requester_nick: r.targetName,
      })));
    },
  }),

  // get_group_shut_list — SnowLuma 无独立"禁言列表"cmd，按成员列表的
  // shutUpTime 字段（绝对到期时间戳，秒）派生：保留仍在禁言中的成员。
  // 走带 TTL 缓存的 fetchGroupMemberList（风控友好，0xfe7 高频会触发腾讯封号），
  // 与 NapCat 文档返回形状 {user_id,nickname,shut_up_time} 对齐。
  // 取舍：NapCat 此接口实时，本实现复用成员缓存，故结果最长有 ~60s 延迟——
  // 刚下/解的禁言可能在该窗口内未反映，属可接受的低频运维查询取舍。
  groupAction({
    name: 'get_group_shut_list',
    summary: '获取群禁言列表',
    readOnly: true,
    run: async (p, ctx) => {
      const members = await ctx.bridge.apis.contacts.fetchGroupMemberList(p.group_id);
      const nowSec = Math.floor(Date.now() / 1000);
      const list = members
        .filter((m) => (m.shutUpTime ?? 0) > nowSec)
        .map((m) => ({ user_id: m.uin, nickname: m.nickname, shut_up_time: m.shutUpTime }));
      return okResponse(list);
    },
  }),

  // get_group_signed_list — 群今日打卡名单。NapCat 走 qun.qq.com 的
  // v2/signin/trpc/GetDaySignedList（HTTP + PSKey），非 OIDB；SnowLuma 复用
  // 现有 web cookie/bkn 基建（与群公告/精华同套路），故无需 RE。失败/无打卡返回空表。
  groupAction({
    name: 'get_group_signed_list',
    summary: '获取群今日打卡列表',
    readOnly: true,
    run: async (p, ctx) => {
      try {
        const list = await ctx.bridge.apis.web.getSignedList(p.group_id);
        return okResponse(list);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, e instanceof Error ? e.message : String(e));
      }
    },
  }),

  defineAction({
    name: 'forward_friend_single_msg',
    summary: '转发单条消息给好友',
    params: {
      message_id: f.messageId(),
      user_id: f.uint(),
    },
    run: async (p, ctx) => {
      try {
        const result = await ctx.forwardSingleMsg(p.message_id, { userId: p.user_id });
        return okResponse({ message_id: result.messageId });
      } catch (err) {
        return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
      }
    },
  }),

  defineAction({
    name: 'forward_group_single_msg',
    summary: '转发单条消息到群',
    params: {
      message_id: f.messageId(),
      group_id: f.uint(),
    },
    run: async (p, ctx) => {
      try {
        const result = await ctx.forwardSingleMsg(p.message_id, { groupId: p.group_id });
        return okResponse({ message_id: result.messageId });
      } catch (err) {
        return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
      }
    },
  }),

  defineAction({
    name: 'get_profile_like',
    summary: '获取资料点赞',
    readOnly: true,
    params: {
      // 原实现 user_id 经 asNumber，无校验（0 也透传）。
      user_id: f.int({ min: 0 }).default(0),
      start: f.int({ min: 0 }).default(0),
      count: f.int({ min: 0 }).default(10),
    },
    run: async (p, ctx) => {
      try {
        const data = await ctx.bridge.apis.profile.getLike(p.user_id, p.start, p.count);
        return okResponse(data);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'fetch_custom_face',
    summary: '获取自定义表情',
    readOnly: true,
    params: {
      count: f.int({ min: 0 }).default(10),
      // return_type=url 返回图片 URL（默认，给前端显示）；
      // return_type=id 返回 emoji_id（给 delete/add 用）。
      return_type: f.string().default('url'),
    },
    run: async (p, ctx) => {
      try {
        const urls = await ctx.bridge.apis.profile.fetchCustomFace(p.count);
        if (p.return_type === 'id') {
          const emojiIds = urls.map((url) => {
            const m = /\/qq_expression\/[^/]+\/([^/]+)\//.exec(url);
            return m ? m[1] : '';
          }).filter(Boolean);
          return okResponse(emojiIds);
        }
        return okResponse(urls);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'get_emoji_likes',
    summary: '获取表情回应用户',
    readOnly: true,
    params: {
      message_id: f.messageId(),
      emoji_id: f.string({ allowEmpty: false }),
    },
    run: async (p, ctx) => {
      try {
        const result = await ctx.fetchEmojiLikeUsers(p.message_id, p.emoji_id, 1000);
        return okResponse({
          emoji_like_list: result.users.map(u => ({ user_id: String(u.uin), nick_name: '' })),
        });
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'fetch_emoji_like',
    summary: '获取表情回应用户（NapCat 分页）',
    readOnly: true,
    params: {
      message_id: f.messageId(),
      emojiId: f.string({ allowEmpty: false }),
      count: f.int({ min: 0 }).default(10),
      cookie: f.string().default(''),
    },
    run: async (p, ctx) => {
      try {
        const offset = p.cookie ? Number.parseInt(p.cookie, 10) || 0 : 0;
        const result = await ctx.fetchEmojiLikeUsers(p.message_id, p.emojiId, p.count, offset);
        const nextOffset = offset + result.users.length;
        const isLastPage = nextOffset >= result.cachedCount;
        return okResponse({
          result: 0,
          errMsg: '',
          emojiLikesList: result.users.map(u => ({ tinyId: String(u.uin), nickName: '', headUrl: '' })),
          cookie: isLastPage ? '' : String(nextOffset),
          isLastPage,
          isFirstPage: offset === 0,
        });
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'get_friends_with_category',
    summary: '获取分组好友列表',
    readOnly: true,
    params: {},
    run: async (_p, ctx) => {
      if (ctx.getFriendList) {
        return okResponse(await ctx.getFriendList());
      }
      return okResponse([]);
    },
  }),

  // get_recent_contact — 最近会话列表（占位）。QQ 原生该接口是内核本地快照
  // （getRecentContactListSnapShot），返回带 peerName/remark/lastestMsg 等丰富
  // 元信息；SnowLuma 既无对应 SSO/packet wire，自有 message store 也只覆盖
  // 「机器人观测到的会话」且缺这些字段，无法忠实复现。故诚实返回空表（而非
  // 用同名接口给出语义有偏差的近似），接受 count 入参以兼容客户端盲调。
  defineAction({
    name: 'get_recent_contact',
    summary: '获取最近会话（占位）',
    readOnly: true,
    params: {
      count: f.int({ min: 0 }).default(10),
    },
    run: async () => {
      return okResponse([]);
    },
  }),

  // get_online_clients — 在线设备列表。NapCat 也拿不到（注册监听后 sleep 500ms
  // 直接返回空），且其返回是裸数组 []，偏离 OneBot v11 / go-cqhttp 规范。
  // SnowLuma 暂无对应单包 SSO cmd，返回 OneBot v11 标准空壳 { clients: [] }
  // ——刻意采用规范形状而非 NapCat 的裸 []，故对照 NapCat 客户端此处不严格 parity。
  defineAction({
    name: 'get_online_clients',
    summary: '获取在线客户端（占位，OneBot v11 形状）',
    readOnly: true,
    params: {},
    run: async () => {
      return okResponse({ clients: [] });
    },
  }),

  // _get_model_show — NapCat 纯内核无 packet wire，其实现是硬编码 mock
  // （无视入参，model_show 恒返回字面量 'napcat'）。SnowLuma 同样无对应单包
  // SSO cmd，故只复用 NapCat 的*外层形状*：data 为数组 [{ variants: {...} }]、
  // need_pay 恒 false；但刻意不照搬其固定字面量——回显请求的 model（缺省
  // 'snowluma'），对调用方更有信息量。属有意的行为分歧，仅形状对齐。
  defineAction({
    name: '_get_model_show',
    summary: '获取机型展示（兼容 mock）',
    readOnly: true,
    params: {
      model: f.string().default(''),
    },
    run: async (p) => {
      const modelShow = p.model || 'snowluma';
      return okResponse([{ variants: { model_show: modelShow, need_pay: false } }]);
    },
  }),

  defineAction({
    name: '_set_model_show',
    summary: '设置机型展示（占位）',
    params: {},
    run: async () => {
      return okResponse();
    },
  }),

  groupAction({
    name: 'get_group_at_all_remain',
    summary: '获取群 @全体成员 剩余次数',
    readOnly: true,
    run: async (p, ctx) => {
      try {
        const data = await ctx.bridge.apis.groupAdmin.getAtAllRemain(p.group_id);
        return okResponse(data);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'get_unidirectional_friend_list',
    summary: '获取单向好友列表',
    readOnly: true,
    params: {},
    run: async (_p, ctx) => {
      try {
        const data = await ctx.bridge.apis.profile.getUnidirectionalFriendList();
        return okResponse(data);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'get_clientkey',
    summary: '获取 clientkey',
    readOnly: true,
    params: {},
    run: async (_p, ctx) => {
      const clientKeyInfo = await ctx.bridge.apis.web.forceFetchClientKey();
      if (!clientKeyInfo.clientKey) {
        return failedResponse(RETCODE.ACTION_FAILED, 'get clientkey error');
      }
      return okResponse({ ...clientKeyInfo });
    },
  }),

  // ─── TierB ③: RE'd OIDB-backed actions (self-constructed packets) ───
  // Recovered from QQNT wrapper.linux.node via IDA (no NapCat packet wire
  // existed to port). All low-frequency/benign ops. See each OIDB service
  // file for the cmd + protobuf provenance.

  // share_peer / send_ark_share — get a "recommend contact" Ark card for a
  // friend (0x9130_0) or group (0x8b7_5). NapCat's SharePeerBase routes by
  // which id is present; we mirror that. Returns the server-built ark JSON.
  defineAction({
    name: 'share_peer',
    summary: '分享用户/群 Ark 卡片',
    readOnly: true,
    params: {
      user_id: f.uint().optional(),
      group_id: f.uint().optional(),
      phone_number: f.string().default(''),
    },
    run: async (p, ctx) => {
      try {
        if (p.group_id) {
          return okResponse({ arkMsg: await ctx.bridge.apis.contacts.getGroupRecommendArk(p.group_id) });
        }
        if (p.user_id) {
          return okResponse({ arkMsg: await ctx.bridge.apis.contacts.getBuddyRecommendArk(p.user_id, p.phone_number) });
        }
        return failedResponse(RETCODE.BAD_REQUEST, 'user_id or group_id is required');
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, e instanceof Error ? e.message : String(e));
      }
    },
  }),
  defineAction({
    name: 'send_ark_share',
    summary: '分享用户/群 Ark 卡片（NapCat 标准名）',
    readOnly: true,
    params: {
      user_id: f.uint().optional(),
      group_id: f.uint().optional(),
      phone_number: f.string().default(''),
    },
    run: async (p, ctx) => {
      try {
        if (p.group_id) {
          return okResponse({ arkMsg: await ctx.bridge.apis.contacts.getGroupRecommendArk(p.group_id) });
        }
        if (p.user_id) {
          return okResponse({ arkMsg: await ctx.bridge.apis.contacts.getBuddyRecommendArk(p.user_id, p.phone_number) });
        }
        return failedResponse(RETCODE.BAD_REQUEST, 'user_id or group_id is required');
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, e instanceof Error ? e.message : String(e));
      }
    },
  }),

  // share_group_ex / send_group_ark_share — group-only Ark share. NapCat uses
  // a distinct kernel API (getArkJsonGroupShare) we did NOT RE; we route to
  // the fully-RE'd group recommend-contact ark (0x8b7_5), the closest
  // confident equivalent. The card may differ slightly from NapCat's.
  defineAction({
    name: 'share_group_ex',
    summary: '分享群 Ark 卡片',
    readOnly: true,
    params: { group_id: f.uint() },
    run: async (p, ctx) => {
      try {
        return okResponse(await ctx.bridge.apis.contacts.getGroupRecommendArk(p.group_id));
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, e instanceof Error ? e.message : String(e));
      }
    },
  }),
  defineAction({
    name: 'send_group_ark_share',
    summary: '分享群 Ark 卡片（NapCat 标准名）',
    readOnly: true,
    params: { group_id: f.uint() },
    run: async (p, ctx) => {
      try {
        return okResponse(await ctx.bridge.apis.contacts.getGroupRecommendArk(p.group_id));
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, e instanceof Error ? e.message : String(e));
      }
    },
  }),

  // get_doubt_friends_add_request — list 可能认识的人 / 被过滤好友申请 (0xd69_0).
  // The list item's `uid` is what set_doubt_friends_add_request takes as flag.
  defineAction({
    name: 'get_doubt_friends_add_request',
    summary: '获取可疑好友申请',
    readOnly: true,
    params: { count: f.int({ min: 0 }).default(50) },
    run: async (p, ctx) => {
      try {
        const list = await ctx.bridge.apis.friend.getDoubtRequests(p.count);
        return okResponse(list);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, e instanceof Error ? e.message : String(e));
      }
    },
  }),
  // set_doubt_friends_add_request — handle a 可疑好友申请 (0xd69_0). `flag` is
  // the uid from the get list. approve → approvalDoubtBuddyReq; approve:false
  // → delDoubtBuddyReq (reject/decline). NapCat only ever approves; we add the
  // reject path since we RE'd delDoubtBuddyReq too.
  defineAction({
    name: 'set_doubt_friends_add_request',
    summary: '处理可疑好友申请',
    params: {
      flag: f.string({ allowEmpty: false }),
      approve: f.bool().default(true),
    },
    run: async (p, ctx) => {
      // approve → approvalDoubtBuddyReq (0xd69_0); reject → delDoubtBuddyReq
      // (also 0xd69_0, distinct body) — both RE'd from the binary.
      try {
        if (p.approve) {
          await ctx.bridge.apis.friend.approveDoubtRequest(p.flag);
        } else {
          await ctx.bridge.apis.friend.rejectDoubtRequest(p.flag);
        }
        return okResponse();
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, e instanceof Error ? e.message : String(e));
      }
    },
  }),

  // set_group_robot_add_option — group robot-add switch/examine via group
  // ext-info (0xf00_3). Omitted params leave the field unchanged.
  groupAction({
    name: 'set_group_robot_add_option',
    summary: '设置群机器人加群选项',
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.groupAdmin.setRobotAddOption(
          p.group_id, p.robot_member_switch, p.robot_member_examine,
        );
        return okResponse();
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, e instanceof Error ? e.message : String(e));
      }
    },
    params: {
      robot_member_switch: f.int({ min: 0 }).optional(),
      robot_member_examine: f.int({ min: 0 }).optional(),
    },
  }),

  defineAction({
    name: 'get_collection_list',
    summary: '获取收藏列表（占位）',
    readOnly: true,
    params: {},
    run: async () => {
      return okResponse([]);
    },
  }),

  defineAction({
    name: 'create_collection',
    summary: '创建收藏（未实现）',
    params: {},
    run: async () => {
      return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
    },
  }),

  defineAction({
    name: '.get_word_slices',
    summary: '分词（未实现）',
    readOnly: true,
    params: {},
    run: async () => {
      return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
    },
  }),

  defineAction({
    name: 'set_qq_avatar',
    summary: '设置 QQ 头像',
    params: { file: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.profile.setAvatar(p.file);
        return okResponse();
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'set_input_status',
    summary: '设置输入状态',
    params: {
      user_id: f.uint(),
      // event_type 可能为 0（取消输入状态）；缺省也按 0 处理（与旧 asNumber 行为一致）。
      event_type: f.int().default(0),
    },
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.profile.setInputStatus(p.user_id, p.event_type);
        return okResponse({});
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'get_group_info_ex',
    summary: '获取群信息（扩展）',
    readOnly: true,
    params: { group_id: f.uint() },
    run: async (p, ctx) => {
      if (ctx.getGroupInfo) {
        return okResponse(await ctx.getGroupInfo(p.group_id));
      }
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    },
  }),

  defineAction({
    name: 'get_group_detail_info',
    summary: '获取群详细信息',
    readOnly: true,
    params: { group_id: f.uint() },
    run: async (p, ctx) => {
      if (ctx.getGroupInfo) {
        return okResponse(await ctx.getGroupInfo(p.group_id));
      }
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    },
  }),

  defineAction({
    name: 'trans_group_file',
    summary: '转存群文件（未实现）',
    params: {},
    run: async () => {
      return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
    },
  }),

  // get_file — 统一文件信息入口。SnowLuma 按 file_id 解析媒体缓存：
  // 先图片、后语音（两者已带 url 重签与 file_size/file_name）。
  // 局限：群文件/普通文件的 file_id 无法在此解析——OneBot `get_file` 单参
  // 签名不含 group_id，而 SnowLuma 群文件下载需要 group 上下文（用
  // get_group_file_url / get_private_file_url）。故此处仅覆盖图片/语音，
  // 不为群文件伪造结果。
  // 注意：缓存双 miss 时无法在此区分"传入的是群文件 file_id"与"图片/语音
  // 确实未缓存（如进程重启丢失）"——run() 不解析 id 形态。故错误信息保持
  // 中性：先陈述"未命中缓存"的事实，再把群文件改用别的接口作为指引，
  // 而非武断断言"不支持"。（summary 仅进离线文档，调用方运行时只看到 wording。）
  defineAction({
    name: 'get_file',
    summary: '获取文件信息（仅图片/语音缓存；群文件请用 get_group_file_url）',
    readOnly: true,
    params: {
      file_id: f.string().default(''),
      file: f.string().default(''),
    },
    run: async (p, ctx) => {
      const fileId = p.file || p.file_id;
      if (!fileId) return failedResponse(RETCODE.BAD_REQUEST, 'file_id is required');
      const image = await ctx.getImageInfo(fileId);
      if (image) return okResponse(image);
      const record = await ctx.getRecordInfo(fileId);
      if (record) return okResponse(record);
      return failedResponse(
        RETCODE.ACTION_FAILED,
        'file_id not found in the image/voice cache. get_file only resolves cached '
        + 'image/voice ids; for group/normal files use get_group_file_url or get_private_file_url',
      );
    },
  }),

  // 机器人生命周期（兼容 NapCat）。
  defineAction({
    name: 'bot_exit',
    summary: '退出机器人',
    params: {},
    run: async () => {
      setTimeout(() => process.exit(0), 50);
      return okResponse();
    },
  }),

  defineAction({
    name: 'nc_get_packet_status',
    summary: '获取 packet 状态（占位）',
    readOnly: true,
    params: {},
    run: async () => {
      return okResponse(null);
    },
  }),

  // NapCat 暴露 delete_group_folder。
  // SnowLuma 现有的 delete_group_file_folder 是相同操作。
  // 添加别名以便遵循 NapCat 文档的客户端无需重写载荷。
  groupAction({
    name: 'delete_group_folder',
    summary: '删除群文件夹',
    params: { folder_id: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupFile.deleteFolder(p.group_id, p.folder_id);
      return okResponse();
    },
  }),

  // 用户在线/扩展状态（NapCat：nc_get_user_status）。
  defineAction({
    name: 'nc_get_user_status',
    summary: '获取用户在线/扩展状态',
    readOnly: true,
    params: { user_id: f.uint() },
    run: async (p, ctx) => {
      const status = await ctx.bridge.apis.extras.getStrangerStatus(p.user_id);
      if (!status) return failedResponse(RETCODE.ACTION_FAILED, 'failed to fetch user status');
      return okResponse({ ...status });
    },
  }),

  // AI 语音（oidb 0x929D / 0x929B）。
  groupAction({
    name: 'get_ai_characters',
    summary: '获取 AI 语音角色',
    readOnly: true,
    params: { chat_type: f.int({ min: 0 }).default(1) },
    run: async (p, ctx) => {
      try {
        const list = await ctx.bridge.apis.extras.fetchAiVoiceList(p.group_id, p.chat_type);
        return okResponse(list.map((cat) => ({
          type: cat.category,
          characters: cat.voices.map((v) => ({
            character_id: v.voiceId,
            character_name: v.voiceDisplayName,
            preview_url: v.voiceExampleUrl,
          })),
        })));
      } catch (err) {
        return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
      }
    },
  }),

  groupAction({
    name: 'get_ai_record',
    summary: '生成 AI 语音',
    params: {
      character: f.string({ allowEmpty: false }),
      text: f.string({ allowEmpty: false }),
      chat_type: f.int({ min: 0 }).default(1),
    },
    run: async (p, ctx) => {
      try {
        const node = await ctx.bridge.apis.extras.fetchAiVoice(p.group_id, p.character, p.text, p.chat_type);
        const url = await ctx.bridge.apis.groupFile.getPttUrl(p.group_id, node);
        return okResponse(url);
      } catch (err) {
        return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
      }
    },
  }),

  // NapCat 的 send_group_ai_record 是仅产生副作用的调用。
  // 调用 fetchAiVoice 会把语音发布到群里。
  // 返回的 message_id 始终为 0，因为 oidb 调用不会回显消息 ID。
  groupAction({
    name: 'send_group_ai_record',
    summary: '发送 AI 语音到群',
    params: {
      character: f.string({ allowEmpty: false }),
      text: f.string({ allowEmpty: false }),
      chat_type: f.int({ min: 0 }).default(1),
    },
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.extras.fetchAiVoice(p.group_id, p.character, p.text, p.chat_type);
        return okResponse({ message_id: 0 });
      } catch (err) {
        return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
      }
    },
  }),

  defineAction({
    name: 'request_decrypt_key',
    summary: '请求数据库解密密钥',
    params: { db_path: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      try {
        const buffer = Buffer.alloc(128);
        const fileHandle = await readFile(p.db_path);

        if (fileHandle.length < 0xaf) {
          return failedResponse(RETCODE.ACTION_FAILED, 'Database file too short');
        }

        fileHandle.copy(buffer, 0, 0x2f, 0xaf);
        const dbSalt = buffer.toString('utf8');

        if (!/^[0-9a-fA-F]{128}$/.test(dbSalt)) {
          return failedResponse(RETCODE.ACTION_FAILED, 'Invalid db_salt: not a valid 128-character hex string');
        }

        const dbKey = await ctx.bridge.apis.misc.getDecryptKey(dbSalt.toLowerCase());

        return okResponse({ db_key: dbKey });
      } catch (err) {
        return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
      }
    },
  }),

  // ===== 原 legacy registerAction，现并入 kit（ctx 调用与逻辑逐字保留；
  // 别名键 / 原始参数透传 / 任意对象经 run 第三参 raw 或 f.raw() 表达）=====

  defineAction({
    name: ['get_rkey', 'nc_get_rkey'],
    summary: '获取下载 rkey',
    readOnly: true,
    params: {},
    run: async (_p, ctx) =>
      ctx.getDownloadRKeys
        ? okResponse(await ctx.getDownloadRKeys())
        : failedResponse(RETCODE.ACTION_FAILED, 'not implemented'),
  }),

  // get_rkey_server — 把下载 rkey 列表（type 10=私聊 / 20=群聊，同 0x9067 来源）
  // 收敛成 NapCat 的 server 形状。expired_time = now + 在场 rkey ttl 的最小值。
  defineAction({
    name: 'get_rkey_server',
    summary: '获取 rkey 服务器信息',
    readOnly: true,
    params: {},
    run: async (_p, ctx) => {
      if (!ctx.getDownloadRKeys) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
      const rkeys = await ctx.getDownloadRKeys();
      const pick = (type: number) =>
        rkeys.find((r) => (r as { type?: number }).type === type) as
          { rkey?: string; ttl?: number } | undefined;
      const priv = pick(10);
      const group = pick(20);
      // No rkey at all → fail rather than hand back an "expired_time = now,
      // no keys" shell that a caching caller would misread as a valid-but-empty
      // (already-expired) result.
      if (!priv?.rkey && !group?.rkey) {
        return failedResponse(RETCODE.ACTION_FAILED, 'no download rkey available');
      }
      const ttls = [priv?.ttl, group?.ttl].filter((t): t is number => typeof t === 'number' && t > 0);
      const minTtl = ttls.length ? Math.min(...ttls) : 0;
      const data: JsonObject = {
        expired_time: Math.floor(Date.now() / 1000) + minTtl,
        name: 'SnowLuma',
      };
      if (priv?.rkey) data.private_rkey = priv.rkey;
      if (group?.rkey) data.group_rkey = group.rkey;
      return okResponse(data);
    },
  }),

  // ocr_image — 服务端 OCR via OIDB 0xE07_0（port 自 Lagrange/NapCat proto）。
  // 该 cmd 接收图片 URL（服务端拉取），故 image 支持：http(s) URL 直用，或
  // 已缓存图片的 file_id（经 getImageInfo 解析出 URL）。base64/本地文件需先
  // 上传换 URL，本实现不覆盖（NapCat 走的是 Windows-only 内核 OCR，不可移植）。
  defineAction({
    name: ['ocr_image', '.ocr_image'],
    summary: 'OCR 图片（服务端，需图片 URL 或已缓存的图片 file_id）',
    readOnly: true,
    params: { image: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      // A passed-in http(s) URL is used verbatim (NOT re-signed) — if it is a
      // stale CDN URL with an expired rkey the server fetch fails and surfaces
      // the server's retCode. The file_id path below re-signs via getImageInfo.
      let url = /^https?:\/\//i.test(p.image) ? p.image : '';
      if (!url) {
        const info = await ctx.getImageInfo(p.image);
        const resolved = info && typeof info.url === 'string' ? info.url : '';
        if (resolved) url = resolved;
      }
      if (!url) {
        return failedResponse(
          RETCODE.ACTION_FAILED,
          'ocr_image needs an http(s) image url or a cached image file_id; '
          + 'base64/local-file input is not supported',
        );
      }
      const result = await ctx.bridge.apis.misc.ocrImage(url);
      // OcrResult is plain JSON data; the interface just lacks an index
      // signature, so coerce for the JsonValue-typed response.
      return okResponse(result as unknown as JsonObject);
    },
  }),

  groupAction({
    name: '_del_group_notice',
    summary: '删除群公告（fid 或 notice_id 二选一）',
    params: { fid: f.string().optional(), notice_id: f.string().optional() },
    run: async (p, ctx) => {
      const fid = p.fid || p.notice_id;
      if (!fid) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and fid/notice_id are required');
      try {
        const success = await ctx.bridge.apis.web.deleteNotice(p.group_id, fid);
        return success ? okResponse() : failedResponse(RETCODE.ACTION_FAILED, 'delete failed');
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'send_forward_msg',
    summary: '发送合并转发（按 message_type/群号自动路由）',
    returns: '{ message_id, res_id, forward_id }',
    // group_id/user_id 是“路由提示”而非身份字段：原实现用 asNumber + `>0` 判断，
    // 占位的 0 表示“该分支不适用”、不应报错。故从 raw 读取（保持旧语义），
    // 只声明 messages/message。
    params: { messages: f.message().optional(), message: f.message().optional() },
    run: async (p, ctx, raw) => {
      const messageType = asString(raw.message_type);
      const groupId = asNumber(raw.group_id);
      const userId = asNumber(raw.user_id);
      const messages = p.messages ?? p.message;
      const meta = readForwardPreviewMeta(raw);
      if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');
      if ((messageType === 'group' || groupId > 0) && ctx.sendGroupForwardMsg) {
        if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
        const result = await ctx.sendGroupForwardMsg(groupId, messages, meta);
        return okResponse({ message_id: result.messageId, res_id: result.forwardId, forward_id: result.forwardId });
      }
      if ((messageType === 'private' || userId > 0) && ctx.sendPrivateForwardMsg) {
        if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
        const result = await ctx.sendPrivateForwardMsg(userId, messages, meta);
        return okResponse({ message_id: result.messageId, res_id: result.forwardId, forward_id: result.forwardId });
      }
      const result = await ctx.sendForwardMsg(messages);
      return okResponse({ message_id: 0, res_id: result.forwardId, forward_id: result.forwardId });
    },
  }),

  groupAction({
    name: 'send_group_forward_msg',
    summary: '发送群合并转发',
    returns: '{ message_id, res_id, forward_id }',
    params: { messages: f.message().optional(), message: f.message().optional() },
    run: async (p, ctx, raw) => {
      const messages = p.messages ?? p.message;
      if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');
      const result = await ctx.sendGroupForwardMsg(p.group_id, messages, readForwardPreviewMeta(raw));
      return okResponse({ message_id: result.messageId, res_id: result.forwardId, forward_id: result.forwardId });
    },
  }),

  defineAction({
    name: 'send_private_forward_msg',
    summary: '发送私聊合并转发',
    returns: '{ message_id, res_id, forward_id }',
    params: { user_id: f.uint(), messages: f.message().optional(), message: f.message().optional() },
    run: async (p, ctx, raw) => {
      const messages = p.messages ?? p.message;
      if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');
      const result = await ctx.sendPrivateForwardMsg(p.user_id, messages, readForwardPreviewMeta(raw));
      return okResponse({ message_id: result.messageId, res_id: result.forwardId, forward_id: result.forwardId });
    },
  }),

  defineAction({
    name: 'get_forward_msg',
    summary: '获取合并转发消息（id 或 message_id）',
    readOnly: true,
    returns: '{ messages }',
    params: { id: f.string().optional() },
    run: async (p, ctx, raw) => {
      let id = p.id || '';
      if (!id) {
        const rawMessageId = raw.message_id;
        const numericMessageId = asNumber(rawMessageId);
        if (numericMessageId > 0) {
          const event = ctx.getMessage(numericMessageId);
          const segments = Array.isArray(event?.message) ? event.message : [];
          for (const seg of segments) {
            if (typeof seg !== 'object' || seg === null || Array.isArray(seg)) continue;
            const so = seg as Record<string, unknown>;
            if (String(so.type ?? '') !== 'forward') continue;
            const data = (typeof so.data === 'object' && so.data !== null && !Array.isArray(so.data))
              ? so.data as Record<string, unknown>
              : null;
            const candidate = asString(data?.id) || asString(data?.res_id) || asString(data?.forward_id);
            if (candidate) { id = candidate; break; }
          }
        }
        if (!id) id = asString(rawMessageId);
      }
      if (!id) return failedResponse(RETCODE.BAD_REQUEST, 'id or message_id is required');
      const messages = await ctx.getForwardMsg(id);
      return okResponse({ messages });
    },
  }),

  defineAction({
    name: 'download_file',
    summary: '下载文件（url 或 base64）到 data/downloads',
    returns: '{ file }',
    params: { url: f.string().default(''), base64: f.string().default(''), name: f.string().default('') },
    run: async (p, _ctx, raw) => {
      const url = p.url;
      const base64 = p.base64;
      const name = p.name;
      if (!url && !base64) return failedResponse(RETCODE.BAD_REQUEST, 'url or base64 is required');
      let buf: Buffer;
      if (base64) {
        const upperBound = Math.floor((base64.length * 3) / 4);
        if (upperBound > DOWNLOAD_FILE_MAX_BYTES) return failedResponse(RETCODE.BAD_REQUEST, `base64 payload too large: > ${DOWNLOAD_FILE_MAX_BYTES} bytes`);
        buf = Buffer.from(base64, 'base64');
        if (buf.length > DOWNLOAD_FILE_MAX_BYTES) return failedResponse(RETCODE.BAD_REQUEST, `base64 payload too large: ${buf.length} > ${DOWNLOAD_FILE_MAX_BYTES} bytes`);
      } else {
        try {
          buf = await fetchDownloadFile(url, parseDownloadHeaders(raw.headers), DOWNLOAD_FILE_MAX_BYTES, DOWNLOAD_FILE_TIMEOUT_MS);
        } catch (err) {
          return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
        }
      }
      try {
        const safe = await saveDownloadBuffer(buf, name);
        return okResponse({ file: safe });
      } catch (err) {
        return failedResponse(RETCODE.BAD_REQUEST, err instanceof Error ? err.message : String(err));
      }
    },
  }),

  defineAction({
    name: 'translate_en2zh',
    summary: '英译中',
    readOnly: true,
    returns: '{ words }',
    params: { words: f.raw() },
    run: async (p, ctx) => {
      const rawWords = p.words;
      if (!Array.isArray(rawWords)) return failedResponse(RETCODE.BAD_REQUEST, 'invalid words array');
      const words = rawWords.map((w) => String(w));
      try {
        const translated = await ctx.bridge.apis.misc.translateEn2Zh(words);
        return okResponse({ words: translated });
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'set_self_longnick',
    summary: '设置个性签名（longNick/long_nick，严格 string）',
    params: { longNick: f.raw(), long_nick: f.raw() },
    run: async (p, ctx) => {
      const longNick = p.longNick || p.long_nick;
      if (typeof longNick !== 'string') return failedResponse(RETCODE.BAD_REQUEST, 'invalid longNick');
      try {
        await ctx.bridge.apis.profile.setSelfLongNick(longNick);
        return okResponse({});
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'get_mini_app_ark',
    summary: '获取小程序卡片 ark',
    readOnly: true,
    params: {},
    run: async (_p, ctx, raw) => {
      const type = raw.type || 'bili';
      const title = raw.title || '';
      const desc = raw.desc || '';
      const picUrl = raw.picUrl || raw.pic_url || '';
      const jumpUrl = raw.jumpUrl || raw.jump_url || '';
      try {
        const data = await ctx.bridge.apis.misc.getMiniAppArk(String(type), String(title), String(desc), String(picUrl), String(jumpUrl));
        return okResponse(data);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  groupAction({
    name: 'click_inline_keyboard_button',
    summary: '点击内联键盘按钮',
    params: { bot_appid: f.uint(), msg_seq: f.uint() },
    run: async (p, ctx, raw) => {
      const buttonId = raw.button_id;
      const callbackData = raw.callback_data || '';
      if (!buttonId) return failedResponse(RETCODE.BAD_REQUEST, 'missing required parameters');
      try {
        const data = await ctx.bridge.apis.misc.clickInlineKeyboardButton(p.group_id, p.bot_appid, String(buttonId), String(callbackData), p.msg_seq);
        return okResponse(data);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  groupAction({
    name: ['set_group_sign', 'send_group_sign'],
    summary: '群签到',
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.misc.sendGroupSign(p.group_id);
        return okResponse({});
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: ['send_packet', '.send_packet'],
    summary: '发送原始 SSO 包（cmd + hex data）',
    params: { cmd: f.string({ allowEmpty: false }), data: f.string().default(''), rsp: f.bool().default(true) },
    run: async (p, ctx) => {
      if (!/^[0-9a-fA-F]*$/.test(p.data) || p.data.length % 2 !== 0) {
        return failedResponse(RETCODE.BAD_REQUEST, 'data must be a hex string of even length');
      }
      try {
        const body = hexToBytes(p.data);
        const result = await ctx.bridge.sendRawPacket(p.cmd, body);
        if (!result.success) return failedResponse(RETCODE.ACTION_FAILED, result.errorMessage || 'send failed');
        if (!p.rsp) return okResponse(null);
        const respHex = result.responseData ? bytesToHex(result.responseData) : '';
        return okResponse(respHex);
      } catch (err) {
        return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
      }
    },
  }),

  groupAction({
    name: 'set_group_todo',
    summary: '设置群待办',
    params: { message_id: f.messageId() },
    run: (p, ctx) => groupTodoRun(p, ctx, (g, s) => ctx.bridge.apis.extras.setGroupTodo(g, s)),
  }),

  groupAction({
    name: 'complete_group_todo',
    summary: '完成群待办',
    params: { message_id: f.messageId() },
    run: (p, ctx) => groupTodoRun(p, ctx, (g, s) => ctx.bridge.apis.extras.completeGroupTodo(g, s)),
  }),

  groupAction({
    name: 'cancel_group_todo',
    summary: '取消群待办',
    params: { message_id: f.messageId() },
    run: (p, ctx) => groupTodoRun(p, ctx, (g, s) => ctx.bridge.apis.extras.cancelGroupTodo(g, s)),
  }),

  // ─────────────── 闪传（FlashTransfer / fileset） ───────────────

  defineAction({
    name: 'create_flash_task',
    summary: '创建闪传任务',
    params: {
      // files 支持单个路径(string)或多个路径(string[])，多文件共用一个 fileset
      files: f.raw(),
      name: f.string().optional(),
      thumb_path: f.string().optional(),
    },
    run: async (p, ctx) => {
      // f.raw() 不做校验，这里归一化为 string[] 并校验
      const rawFiles = p.files;
      let fileList: string[];
      if (typeof rawFiles === 'string') {
        if (rawFiles === '') return failedResponse(RETCODE.BAD_REQUEST, 'files must not be empty');
        fileList = [rawFiles];
      } else if (Array.isArray(rawFiles) && rawFiles.every((x) => typeof x === 'string' && x !== '')) {
        if (rawFiles.length === 0) return failedResponse(RETCODE.BAD_REQUEST, 'files must not be empty');
        fileList = rawFiles as string[];
      } else {
        return failedResponse(RETCODE.BAD_REQUEST, 'files must be a string or string array');
      }
      try {
        const result = await ctx.bridge.apis.flashTransfer.createFlashTask(fileList, p.name, p.thumb_path);
        return okResponse({ fileset_id: result.filesetId, task_id: result.filesetId });
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'get_fileset_info',
    summary: '获取文件集信息',
    params: { fileset_id: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      try {
        const list = await ctx.bridge.apis.flashTransfer.getFilesetInfo(p.fileset_id);
        return okResponse({ fileset_id: p.fileset_id, file_list: list.map(flashFileInfoToJson) });
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'get_flash_file_list',
    summary: '获取闪传文件列表',
    params: { fileset_id: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      try {
        const list = await ctx.bridge.apis.flashTransfer.getFlashFileList(p.fileset_id);
        return okResponse(list.map(flashFileInfoToJson));
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'list_filesets',
    summary: '列出当前账号的所有闪传文件集',
    params: {},
    run: async (_p, ctx) => {
      try {
        const list = await ctx.bridge.apis.flashTransfer.listFilesets();
        return okResponse(list.map(flashFileInfoToJson));
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'get_flash_file_url',
    summary: '获取闪传文件链接',
    params: {
      fileset_id: f.string({ allowEmpty: false }),
      file_name: f.string().optional(),
      file_index: f.number().optional(),
    },
    run: async (p, ctx) => {
      try {
        const url = await ctx.bridge.apis.flashTransfer.getFlashFileUrl(p.fileset_id, p.file_index);
        return okResponse({ url });
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'get_share_link',
    summary: '获取文件分享链接',
    params: { fileset_id: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      try {
        const url = await ctx.bridge.apis.flashTransfer.getShareLink(p.fileset_id);
        return okResponse(url);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'delete_flash_file',
    summary: '删除闪传文件',
    params: { fileset_id: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.flashTransfer.deleteFlashFile(p.fileset_id);
        return okResponse();
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'rename_flash_file',
    summary: '重命名闪传文件',
    params: {
      fileset_id: f.string({ allowEmpty: false }),
      new_name: f.string({ allowEmpty: false }),
    },
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.flashTransfer.renameFlashFile(p.fileset_id, p.new_name);
        return okResponse();
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, String(e));
      }
    },
  }),

  defineAction({
    name: 'download_fileset',
    summary: '解析闪传文件下载直链（不下载，由调用方实现下载）',
    returns: '{ url, file_name, file_size }',
    params: {
      fileset_id: f.string({ allowEmpty: false }),
      file_name: f.string().optional(),
      file_index: f.number().optional(),
    },
    run: async (p, ctx) => {
      try {
        const target = await ctx.bridge.apis.flashTransfer.downloadFileset(p.fileset_id, {
          fileName: p.file_name,
          fileIndex: p.file_index,
        });
        return okResponse({
          url: target.url,
          file_name: target.fileName,
          file_size: target.fileSize,
        });
      } catch (err) {
        return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
      }
    },
  }),

  defineAction({
    name: 'send_flash_msg',
    summary: '发送闪传消息（私聊或群聊，引用 fileset_id 让对端下载）',
    returns: '{ message_id }',
    params: {
      fileset_id: f.string({ allowEmpty: false }),
      user_id: f.uint().optional(),
      group_id: f.uint().optional(),
    },
    run: async (p, ctx) => {
      if (!p.user_id && !p.group_id) {
        return failedResponse(RETCODE.BAD_REQUEST, 'user_id or group_id is required');
      }
      try {
        await ctx.bridge.apis.flashTransfer.sendFlashMsg(p.fileset_id, {
          userId: p.user_id,
          groupId: p.group_id,
        });
        // 0x93d7 响应无 message_id（分享 fileset，非传统消息），返回 0 兼容 OneBot 形状。
        return okResponse({ message_id: 0 });
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, e instanceof Error ? e.message : String(e));
      }
    },
  }),

  defineAction({
    name: 'get_fileset_id',
    summary: '从分享码/链接获取 fileset_id',
    readOnly: true,
    returns: '{ fileset_id }',
    params: { share_code: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      try {
        const filesetId = await ctx.bridge.apis.flashTransfer.getFilesetIdByCode(p.share_code);
        return okResponse({ fileset_id: filesetId });
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, e instanceof Error ? e.message : String(e));
      }
    },
  }),
];

// 已过滤（机器人/被忽略）的入群请求。
// SnowLuma 已通过 fetchGroupRequests 实现底层 oidb 0x10c8_2 拉取。
// 这几个动作只是为实际使用中的 OneBot 方言客户端重命名并投影相同数据。
async function fetchFilteredGroupRequests(ctx: ApiActionContext) {
  try {
    return await ctx.bridge.apis.contacts.fetchGroupRequests(true);
  } catch {
    return [];
  }
}

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  registerActions(h, ctx, actions);

  // .handle_quick_operation 仍保留 legacy：它需要把 ApiHandler 本身 (h) 交给
  // executeQuickOperation 去回灌动作，而 action-kit 的 run 只提供 (p, ctx, raw)、不含 h。
  h.registerAction('.handle_quick_operation', async (params) => {
    const context = params.context as JsonObject | undefined;
    const operation = params.operation as Record<string, unknown> | undefined;
    if (!context || !operation) return failedResponse(RETCODE.BAD_REQUEST, 'context and operation are required');
    const { executeQuickOperation } = await import('../network/quick-operation');
    await executeQuickOperation(context, operation, h);
    return okResponse();
  });
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(buf: Buffer | Uint8Array): string {
  const arr = buf instanceof Buffer ? buf : Buffer.from(buf);
  return arr.toString('hex');
}

function parseDownloadHeaders(headers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  const headerList: string[] = [];
  if (typeof headers === 'string') {
    headerList.push(...headers.split(/\r?\n/).filter(Boolean));
  } else if (Array.isArray(headers)) {
    for (const h of headers) {
      if (typeof h === 'string') headerList.push(h);
    }
  }
  for (const line of headerList) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      result[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
    }
  }
  return result;
}
