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

  // 消息历史
  groupAction({
    name: 'get_group_msg_history',
    summary: '获取群消息历史',
    readOnly: true,
    params: {
      // 原实现用 `asNumber(message_id) || 0`，present 0 也映射为 0。
      message_id: f.int({ min: 0 }).default(0),
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
      message_id: f.int({ min: 0 }).default(0),
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

  defineAction({
    name: '_mark_all_as_read',
    summary: '标记全部已读',
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

  // get_group_shut_list 依赖尚未封装的 oidb。
  // 这里遵循 NapCat 约定返回空列表，避免调用方出错。
  defineAction({
    name: 'get_group_shut_list',
    summary: '获取群禁言列表（占位）',
    readOnly: true,
    params: {},
    run: async () => {
      return okResponse([]);
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
    params: { count: f.int({ min: 0 }).default(10) },
    run: async (p, ctx) => {
      try {
        const urls = await ctx.bridge.apis.profile.fetchCustomFace(p.count);
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

  // NapCat 似乎也用不了，暂时不处理。
  defineAction({
    name: 'get_online_clients',
    summary: '获取在线客户端（占位）',
    readOnly: true,
    params: {},
    run: async () => {
      return okResponse({ clients: [] });
    },
  }),

  defineAction({
    name: '_get_model_show',
    summary: '获取机型展示（占位）',
    readOnly: true,
    params: {},
    run: async () => {
      return okResponse({ variants: [] });
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

  defineAction({
    name: 'rename_group_file',
    summary: '重命名群文件（未实现）',
    params: {},
    run: async () => {
      return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
    },
  }),

  defineAction({
    name: 'get_file',
    summary: '获取文件（未实现）',
    readOnly: true,
    params: {
      file_id: f.string().default(''),
      file: f.string().default(''),
    },
    run: async (p) => {
      const fileId = p.file_id || p.file;
      if (!fileId) return failedResponse(RETCODE.BAD_REQUEST, 'file_id is required');
      return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
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

  defineAction({
    name: ['ocr_image', '.ocr_image'],
    summary: 'OCR 图片（未实现）',
    readOnly: true,
    params: {},
    run: () => failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented'),
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
      const fs = await import('fs');
      const pathMod = await import('path');
      const cryptoMod = await import('crypto');
      const tempDir = pathMod.resolve('data', 'downloads');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const resolveSafePath = (preferredName: string, fallbackBuf: Buffer): string | null => {
        const rawName = preferredName || cryptoMod.createHash('md5').update(fallbackBuf).digest('hex');
        const safeName = pathMod.basename(rawName);
        if (!safeName || safeName === '.' || safeName === '..' || /[\\/]/.test(safeName)) return null;
        const resolved = pathMod.resolve(tempDir, safeName);
        const rel = pathMod.relative(tempDir, resolved);
        if (rel.startsWith('..') || pathMod.isAbsolute(rel)) return null;
        return resolved;
      };
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
      const safe = resolveSafePath(name, buf);
      if (!safe) return failedResponse(RETCODE.BAD_REQUEST, 'invalid file name');
      await fs.promises.writeFile(safe, buf);
      return okResponse({ file: safe });
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
