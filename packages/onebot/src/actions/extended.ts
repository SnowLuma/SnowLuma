import { readFile } from 'node:fs/promises';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import { asBoolean, asMessage, asNumber, asString } from '../api-handler';
import type { ForwardPreviewMeta } from '../modules/message-actions';
import { JsonObject, RETCODE, failedResponse, okResponse } from '../types';

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

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  // 赞
  h.registerAction('send_like', async (params) => {
    const userId = asNumber(params.user_id);
    const times = asNumber(params.times) || 1;
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    await ctx.bridge.apis.interaction.sendLike(userId, times);
    return okResponse();
  });
  // 拍一拍
  h.registerAction('friend_poke', async (params) => {
    const userId = asNumber(params.user_id);
    const targetId = asNumber(params.target_id) || undefined;
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    await ctx.bridge.apis.interaction.sendPoke(false, userId, targetId);
    return okResponse();
  });

  h.registerAction('group_poke', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    await ctx.bridge.apis.interaction.sendPoke(true, groupId, userId);
    return okResponse();
  });

  h.registerAction('send_poke', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    if (groupId) {
      await ctx.bridge.apis.interaction.sendPoke(true, groupId, userId);
    } else {
      await ctx.bridge.apis.interaction.sendPoke(false, userId);
    }
    return okResponse();
  });

  // 精华消息
  h.registerAction('set_essence_msg', async (params) => {
    const messageId = asNumber(params.message_id);
    if (!Number.isInteger(messageId) || messageId === 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
    }
    await ctx.setEssenceMsg(messageId);
    return okResponse();
  });

  h.registerAction('delete_essence_msg', async (params) => {
    const messageId = asNumber(params.message_id);
    if (!Number.isInteger(messageId) || messageId === 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
    }
    await ctx.deleteEssenceMsg(messageId);
    return okResponse();
  });

  h.registerAction('get_essence_msg_list', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');


    try {
      const essenceDataAll = await ctx.bridge.apis.web.getEssenceAll(groupId);

      const allMsgs = essenceDataAll.flatMap((res) => res.data?.msg_list || []);

      return okResponse(allMsgs);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, `获取精华消息失败: ${e}`);
    }
  });

  // 群聊表情回应
  h.registerAction('set_group_reaction', async (params) => {
    const groupId = asNumber(params.group_id);
    const messageId = asNumber(params.message_id);
    const code = asString(params.code);
    const isSet = asBoolean(params.is_set, true);

    if (!Number.isInteger(messageId) || messageId === 0 || !code) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message_id and code are required');
    }

    const meta = ctx.getMessageMeta(messageId);
    if (!meta || !meta.isGroup) {
      return failedResponse(RETCODE.ACTION_FAILED, 'message not found or not a group message');
    }

    if (groupId && groupId !== meta.targetId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id does not match message session');
    }

    await ctx.bridge.apis.interaction.setReaction(meta.targetId, meta.sequence, code, isSet);
    return okResponse();
  });

  // 消息历史
  h.registerAction('get_group_msg_history', async (params) => {
    const groupId = asNumber(params.group_id);
    const messageId = asNumber(params.message_id) || 0;
    const count = asNumber(params.count) || 20;
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    const messages = await ctx.getGroupMsgHistory(groupId, messageId, count);
    return okResponse({ messages });
  });

  h.registerAction('get_friend_msg_history', async (params) => {
    const userId = asNumber(params.user_id);
    const messageId = asNumber(params.message_id) || 0;
    const count = asNumber(params.count) || 20;
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    const messages = await ctx.getFriendMsgHistory(userId, messageId, count);
    return okResponse({ messages });
  });

  // 标记消息已读
  h.registerAction('mark_group_msg_as_read', async (params) => {
    const messageId = asNumber(params.message_id);
    const groupId = asNumber(params.group_id);

    if (!Number.isInteger(messageId) || messageId === 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
    }
    const meta = ctx.getMessageMeta(messageId);
    if (!meta || !meta.isGroup) {
      return failedResponse(RETCODE.ACTION_FAILED, 'message not found or not a group message');
    }

    if (groupId && groupId !== meta.targetId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id does not match message session');
    }

    await ctx.bridge.apis.message.markGroupRead(meta.targetId, meta.sequence);
    return okResponse();
  });

  h.registerAction('mark_private_msg_as_read', async (params) => {
    const messageId = asNumber(params.message_id);
    const userId = asNumber(params.user_id);

    if (!Number.isInteger(messageId) || messageId === 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
    }
    const meta = ctx.getMessageMeta(messageId);
    if (!meta || meta.isGroup) {
      return failedResponse(RETCODE.ACTION_FAILED, 'message not found or not a private message');
    }

    if (userId && userId !== meta.targetId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'user_id does not match message session');
    }

    await ctx.bridge.apis.message.markPrivateRead(meta.targetId, meta.sequence);
    return okResponse();
  });

  h.registerAction('mark_msg_as_read', async (params) => {
    const messageId = asNumber(params.message_id);
    const targetId = asNumber(params.target_id);

    if (!Number.isInteger(messageId) || messageId === 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
    }
    const meta = ctx.getMessageMeta(messageId);
    if (!meta) return failedResponse(RETCODE.ACTION_FAILED, 'message not found');

    if (targetId && targetId !== meta.targetId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'target_id does not match message session');
    }

    if (meta.isGroup) {
      await ctx.bridge.apis.message.markGroupRead(meta.targetId, meta.sequence);
    } else {
      await ctx.bridge.apis.message.markPrivateRead(meta.targetId, meta.sequence);
    }
    return okResponse();
  });


  // 下载密钥
  const handleGetRkey = async () => {
    if (ctx.getDownloadRKeys) {
      return okResponse(await ctx.getDownloadRKeys());
    }
    return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
  };
  h.registerAction('get_rkey', handleGetRkey);
  h.registerAction('nc_get_rkey', handleGetRkey);

  // OCR 兜底未实现。

  h.registerAction('ocr_image', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });

  h.registerAction('.ocr_image', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });

  // 群公告
  h.registerAction('_send_group_notice', async (params) => {
    const groupId = asNumber(params.group_id);
    const content = asString(params.content);
    const image = asString(params.image);

    if (!groupId || !content) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id and content are required');
    }


    try {
      const options = {
        image: image || undefined,
        pinned: params.pinned !== undefined ? Number(params.pinned) : 0,
        type: params.type !== undefined ? Number(params.type) : 1,
        confirm_required: params.confirm_required !== undefined ? Number(params.confirm_required) : 1,
      };

      await ctx.bridge.apis.web.sendNotice(groupId, content, options);
      return okResponse();
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('_get_group_notice', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');


    try {
      const notices = await ctx.bridge.apis.web.getNotice(groupId);
      return okResponse(notices);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('_del_group_notice', async (params) => {
    const groupId = asNumber(params.group_id);
    const fid = asString(params.fid) || asString(params.notice_id);

    if (!groupId || !fid) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id and fid/notice_id are required');
    }


    try {
      const success = await ctx.bridge.apis.web.deleteNotice(groupId, fid);
      if (success) {
        return okResponse();
      } else {
        return failedResponse(RETCODE.ACTION_FAILED, 'delete failed');
      }
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  // 转发消息。
  h.registerAction('upload_forward_msg', async (params) => {
    const messages = asMessage(params.messages ?? params.message);
    const groupId = asNumber(params.group_id);
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
  });

  h.registerAction('upload_foward_msg', async (params) => {
    const messages = asMessage(params.messages ?? params.message);
    const groupId = asNumber(params.group_id);
    if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');
    const result = await ctx.sendForwardMsg(messages, groupId > 0 ? groupId : undefined);
    return okResponse({ res_id: result.forwardId, forward_id: result.forwardId, message_id: 0 });
  });

  h.registerAction('send_forward_msg', async (params) => {
    const messageType = asString(params.message_type);
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    const messages = asMessage(params.messages ?? params.message);
    const meta = readForwardPreviewMeta(params);

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
  });

  h.registerAction('send_group_forward_msg', async (params) => {
    const groupId = asNumber(params.group_id);
    const messages = asMessage(params.messages ?? params.message);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');

    const result = await ctx.sendGroupForwardMsg(groupId, messages, readForwardPreviewMeta(params));
    return okResponse({ message_id: result.messageId, res_id: result.forwardId, forward_id: result.forwardId });
  });

  h.registerAction('send_private_forward_msg', async (params) => {
    const userId = asNumber(params.user_id);
    const messages = asMessage(params.messages ?? params.message);
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');

    const result = await ctx.sendPrivateForwardMsg(userId, messages, readForwardPreviewMeta(params));
    return okResponse({ message_id: result.messageId, res_id: result.forwardId, forward_id: result.forwardId });
  });

  h.registerAction('get_forward_msg', async (params) => {
    let id = asString(params.id);
    if (!id) {
      const rawMessageId = params.message_id;
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
          if (candidate) {
            id = candidate;
            break;
          }
        }
      }

      if (!id) {
        id = asString(rawMessageId);
      }
    }

    if (!id) return failedResponse(RETCODE.BAD_REQUEST, 'id or message_id is required');

    const messages = await ctx.getForwardMsg(id);
    return okResponse({ messages });
  });

  // 文件信息

  h.registerAction('get_image', async (params) => {
    const file = asString(params.file) || asString(params.file_id);
    if (!file) return failedResponse(RETCODE.BAD_REQUEST, 'file is required');
    const info = await ctx.getImageInfo(file);
    if (info) return okResponse(info);
    return failedResponse(RETCODE.ACTION_FAILED, 'image not found in cache');
  });

  h.registerAction('get_record', async (params) => {
    const file = asString(params.file) || asString(params.file_id);
    if (!file) return failedResponse(RETCODE.BAD_REQUEST, 'file is required');
    const info = await ctx.getRecordInfo(file);
    if (info) return okResponse(info);
    return failedResponse(RETCODE.ACTION_FAILED, 'record not found in cache');
  });

  // Cookie、CSRF 令牌和账号信息

  h.registerAction('get_cookies', async (params) => {
    const domain = asString(params.domain) || 'qun.qq.com';


    try {
      const cookies = await ctx.bridge.apis.web.getCookiesStr(domain);
      return okResponse({ cookies });
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_csrf_token', async () => {

    try {
      const token = await ctx.bridge.apis.web.getCsrfToken();
      return okResponse({ token });
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_credentials', async (params) => {
    const domain = asString(params.domain) || 'qun.qq.com';


    try {
      const creds = await ctx.bridge.apis.web.getCredentials(domain);
      return okResponse(creds);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });
  // 重启和清理缓存

  h.registerAction('set_restart', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not supported');
  });

  h.registerAction('clean_cache', async () => {
    return okResponse();
  });

  h.registerAction('.handle_quick_operation', async (params) => {
    const context = params.context as import('../types').JsonObject | undefined;
    const operation = params.operation as Record<string, unknown> | undefined;
    if (!context || !operation) return failedResponse(RETCODE.BAD_REQUEST, 'context and operation are required');
    const { executeQuickOperation } = await import('../network/quick-operation');
    await executeQuickOperation(context, operation, h);
    return okResponse();
  });

  // 以下接口在方便用户迁移和兼容现有的 OneBot/NapCat 客户端。
  h.registerAction('set_friend_remark', async (params) => {
    const userId = asNumber(params.user_id);
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    if (params.remark === undefined) {
      return failedResponse(RETCODE.BAD_REQUEST, 'remark is required (pass an empty string to clear)');
    }
    await ctx.bridge.apis.friend.setRemark(userId, asString(params.remark));
    return okResponse();
  });

  h.registerAction('set_group_remark', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (params.remark === undefined) {
      return failedResponse(RETCODE.BAD_REQUEST, 'remark is required (pass an empty string to clear)');
    }
    await ctx.bridge.apis.groupAdmin.setRemark(groupId, asString(params.remark));
    return okResponse();
  });

  h.registerAction('set_msg_emoji_like', async (params) => {
    const messageId = asNumber(params.message_id);
    const emojiId = asString(params.emoji_id);
    const set = asBoolean(params.set, true);
    if (!Number.isInteger(messageId) || messageId === 0 || !emojiId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message_id and emoji_id are required');
    }
    await ctx.setMsgEmojiLike(messageId, emojiId, set);
    return okResponse();
  });


  h.registerAction('_mark_all_as_read', async () => {
    return okResponse();
  });

  h.registerAction('get_group_file_system_info', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    const info = await ctx.bridge.apis.groupFile.getCount(groupId);
    return okResponse({
      file_count: info.fileCount,
      limit_count: info.maxCount,
      used_space: 0,
      total_space: 10737418240,
    });
  });

  h.registerAction('check_url_safely', async () => {
    return okResponse({ level: 1 });
  });

  h.registerAction('download_file', async (params) => {
    const url = asString(params.url);
    const base64 = asString(params.base64);
    const name = asString(params.name);
    if (!url && !base64) return failedResponse(RETCODE.BAD_REQUEST, 'url or base64 is required');

    const fs = await import('fs');
    const pathMod = await import('path');
    const cryptoMod = await import('crypto');
    const tempDir = pathMod.resolve('data', 'downloads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    // 清理文件名：移除所有路径部分，并拒绝任何会解析到 tempDir 外部的路径。
    // 如果没有这个保护，name = "../../config/onebot_x.json" 会让已认证的 OneBot 客户端覆盖工作目录下的任意文件。
    // 例如 config、dist、node_modules 等目录中的文件。
    const resolveSafePath = (preferredName: string, fallbackBuf: Buffer): string | null => {
      const raw = preferredName || cryptoMod.createHash('md5').update(fallbackBuf).digest('hex');
      const safeName = pathMod.basename(raw);
      if (!safeName || safeName === '.' || safeName === '..' || /[\\/]/.test(safeName)) return null;
      const resolved = pathMod.resolve(tempDir, safeName);
      const rel = pathMod.relative(tempDir, resolved);
      if (rel.startsWith('..') || pathMod.isAbsolute(rel)) return null;
      return resolved;
    };

    let buf: Buffer;
    if (base64) {
      // 每 4 个 base64 字符最多解码成 3 个字节。
      // 在 Buffer.from 分配内存前先拒绝过大的载荷，避免最终也无法通过解码后检查的大载荷导致内存溢出。
      const upperBound = Math.floor((base64.length * 3) / 4);
      if (upperBound > DOWNLOAD_FILE_MAX_BYTES) {
        return failedResponse(RETCODE.BAD_REQUEST, `base64 payload too large: > ${DOWNLOAD_FILE_MAX_BYTES} bytes`);
      }
      buf = Buffer.from(base64, 'base64');
      if (buf.length > DOWNLOAD_FILE_MAX_BYTES) {
        return failedResponse(RETCODE.BAD_REQUEST, `base64 payload too large: ${buf.length} > ${DOWNLOAD_FILE_MAX_BYTES} bytes`);
      }
    } else {
      try {
        buf = await fetchDownloadFile(
          url!,
          parseDownloadHeaders(params.headers),
          DOWNLOAD_FILE_MAX_BYTES,
          DOWNLOAD_FILE_TIMEOUT_MS,
        );
      } catch (err) {
        return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
      }
    }

    const safe = resolveSafePath(name, buf);
    if (!safe) return failedResponse(RETCODE.BAD_REQUEST, 'invalid file name');
    // 使用异步写入，避免 GiB 级下载阻塞事件循环。
    // 之前的 writeFileSync 会在运行期间卡住其他所有机器人动作。
    await fs.promises.writeFile(safe, buf);
    return okResponse({ file: safe });
  });

  h.registerAction('set_qq_profile', async (params) => {

    const nickname = params.nickname !== undefined ? asString(params.nickname) : undefined;
    const personalNote = params.personal_note !== undefined ? asString(params.personal_note) : undefined;


    try {
      await ctx.bridge.apis.profile.setProfile(nickname, personalNote);
      return okResponse();
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('set_online_status', async (params) => {
    const status = asNumber(params.status);
    const extStatus = asNumber(params.ext_status) || 0;
    const batteryStatus = asNumber(params.battery_status) || 100;

    // 参数校验
    if (status === undefined || status === 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'status is required');
    }


    try {
      await ctx.bridge.apis.profile.setOnlineStatus(status, extStatus, batteryStatus);
      return okResponse();
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  // 自定义在线状态：与 set_online_status 使用相同的网络包。
  // 这里只填充 customExt 子消息，并将 status/extStatus 强制设为 QQ 定义的“我有自定义状态”取值（10 / 2000）。
  // face_id 和 face_type 可接受数字或数字字符串，以兼容 NapCat；wording 是图标旁展示的可读文本。
  h.registerAction('set_diy_online_status', async (params) => {
    const faceId = asNumber(params.face_id);
    const faceType = asNumber(params.face_type) || 1;
    const wording = asString(params.wording);
    if (!faceId) return failedResponse(RETCODE.BAD_REQUEST, 'face_id is required');
    try {
      await ctx.bridge.apis.profile.setDiyOnlineStatus(faceId, wording, faceType);
      return okResponse();
    } catch (err) {
      return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
    }
  });

  // 已过滤（机器人/被忽略）的入群请求。
  // SnowLuma 已通过 fetchGroupRequests 实现底层 oidb 0x10c8_2 拉取。
  // 这几个动作只是为实际使用中的 OneBot 方言客户端重命名并投影相同数据。
  const fetchFilteredGroupRequests = async () => {
    try {
      return await ctx.bridge.apis.contacts.fetchGroupRequests(true);
    } catch {
      return [];
    }
  };

  h.registerAction('get_group_ignored_notifies', async () => {
    const reqs = await fetchFilteredGroupRequests();
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
  });

  // NapCat 对“被忽略通知中属于入群请求的子集”的命名（notify type == 7）。
  // 这里把经过过滤的 0x10c8_2 每一项映射成 NapCat 结构。
  // eventType 已经在当前流水线中编码了请求类别。
  h.registerAction('get_group_ignore_add_request', async () => {
    const reqs = await fetchFilteredGroupRequests();
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
  });

  // get_group_shut_list 依赖尚未封装的 oidb。
  // 这里遵循 NapCat 约定返回空列表，避免调用方出错。
  h.registerAction('get_group_shut_list', async () => {
    return okResponse([]);
  });

  h.registerAction('forward_friend_single_msg', async (params) => {
    const messageId = asNumber(params.message_id);
    const userId = asNumber(params.user_id);
    if (!messageId) return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    try {
      const result = await ctx.forwardSingleMsg(messageId, { userId });
      return okResponse({ message_id: result.messageId });
    } catch (err) {
      return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
    }
  });

  h.registerAction('forward_group_single_msg', async (params) => {
    const messageId = asNumber(params.message_id);
    const groupId = asNumber(params.group_id);
    if (!messageId) return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    try {
      const result = await ctx.forwardSingleMsg(messageId, { groupId });
      return okResponse({ message_id: result.messageId });
    } catch (err) {
      return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
    }
  });

  h.registerAction('get_profile_like', async (params) => {
    const userId = asNumber(params.user_id);
    const start = asNumber(params.start) || 0;
    const count = asNumber(params.count) || 10;
    try {
      const data = await ctx.bridge.apis.profile.getLike(userId, start, count);
      return okResponse(data);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('fetch_custom_face', async (params) => {
    const count = asNumber(params.count) || 10;
    try {
      const urls = await ctx.bridge.apis.profile.fetchCustomFace(count);
      return okResponse(urls);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_emoji_likes', async (params) => {
    const messageId = asNumber(params.message_id);
    const emojiId = asString(params.emoji_id) || '';
    if (!messageId || !emojiId) return failedResponse(RETCODE.BAD_REQUEST, 'message_id and emoji_id are required');
    try {
      const result = await ctx.fetchEmojiLikeUsers(messageId, emojiId, 1000);
      return okResponse({
        emoji_like_list: result.users.map(u => ({ user_id: String(u.uin), nick_name: '' })),
      });
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('fetch_emoji_like', async (params) => {
    const messageId = asNumber(params.message_id);
    const emojiId = asString(params.emojiId) || '';
    const count = asNumber(params.count) || 10;
    const cookie = asString(params.cookie) || '';
    if (!messageId || !emojiId) return failedResponse(RETCODE.BAD_REQUEST, 'message_id and emojiId are required');
    try {
      const offset = cookie ? Number.parseInt(cookie, 10) || 0 : 0;
      const result = await ctx.fetchEmojiLikeUsers(messageId, emojiId, count, offset);
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
  });

  h.registerAction('get_friends_with_category', async () => {
    if (ctx.getFriendList) {
      return okResponse(await ctx.getFriendList());
    }
    return okResponse([]);
  });

  // NapCat 似乎也用不了，暂时不处理。
  h.registerAction('get_online_clients', async () => {
    return okResponse({ clients: [] });
  });

  h.registerAction('_get_model_show', async () => {
    return okResponse({ variants: [] });
  });

  h.registerAction('_set_model_show', async () => {
    return okResponse();
  });

  h.registerAction('.get_word_slices', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });

  h.registerAction('get_group_at_all_remain', async (params) => {
    const groupId = asNumber(params.group_id);

    if (!groupId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'invalid group_id');
    }
    try {
      const data = await ctx.bridge.apis.groupAdmin.getAtAllRemain(groupId);
      return okResponse(data);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_unidirectional_friend_list', async () => {

    try {
      const data = await ctx.bridge.apis.profile.getUnidirectionalFriendList();
      return okResponse(data);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('set_self_longnick', async (params) => {
    const longNick = params.longNick || params.long_nick;

    if (typeof longNick !== 'string') {
      return failedResponse(RETCODE.BAD_REQUEST, 'invalid longNick');
    }
    try {
      await ctx.bridge.apis.profile.setSelfLongNick(longNick);
      return okResponse({});
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_collection_list', async () => {
    return okResponse([]);
  });

  h.registerAction('create_collection', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });

  h.registerAction('set_qq_avatar', async (params) => {
    const file = asString(params.file);
    if (!file) return failedResponse(RETCODE.BAD_REQUEST, 'file is required');


    try {
      await ctx.bridge.apis.profile.setAvatar(file);
      return okResponse();
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('set_input_status', async (params) => {
    const userId = asNumber(params.user_id);
    const eventType = asNumber(params.event_type);

    if (!userId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'invalid user_id');
    }

    // event_type 有可能是 0 (取消输入状态)，所以这里严格判断 undefined 或 isNaN
    if (eventType === undefined || isNaN(eventType)) {
      return failedResponse(RETCODE.BAD_REQUEST, 'invalid event_type');
    }

    try {
      await ctx.bridge.apis.profile.setInputStatus(userId, eventType);
      return okResponse({});
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('translate_en2zh', async (params) => {
    const rawWords = params.words;

    if (!Array.isArray(rawWords)) {
      return failedResponse(RETCODE.BAD_REQUEST, 'invalid words array');
    }

    const words = rawWords.map(w => String(w));


    try {
      const translated = await ctx.bridge.apis.misc.translateEn2Zh(words);
      return okResponse({ words: translated });
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_clientkey', async () => {
    const clientKeyInfo = await ctx.bridge.apis.web.forceFetchClientKey();
    if (!clientKeyInfo.clientKey) {
      return failedResponse(RETCODE.ACTION_FAILED, 'get clientkey error');
    }
    return okResponse({ ...clientKeyInfo });
  });

  h.registerAction('get_mini_app_ark', async (params) => {
    const type = params.type || 'bili';
    const title = params.title || '';
    const desc = params.desc || '';
    const picUrl = params.picUrl || params.pic_url || '';
    const jumpUrl = params.jumpUrl || params.jump_url || '';


    try {
      const data = await ctx.bridge.apis.misc.getMiniAppArk(
        String(type),
        String(title),
        String(desc),
        String(picUrl),
        String(jumpUrl)
      );
      return okResponse(data);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('click_inline_keyboard_button', async (params) => {
    const groupId = asNumber(params.group_id);
    const botAppid = asNumber(params.bot_appid);
    const buttonId = params.button_id;
    const callbackData = params.callback_data || '';
    const msgSeq = asNumber(params.msg_seq);

    if (!groupId || !botAppid || !buttonId || !msgSeq) {
      return failedResponse(RETCODE.BAD_REQUEST, 'missing required parameters');
    }


    try {
      const data = await ctx.bridge.apis.misc.clickInlineKeyboardButton(
        groupId,
        botAppid,
        String(buttonId),
        String(callbackData),
        msgSeq
      );
      return okResponse(data);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  const handleGroupSign = async (params: import('../types').JsonObject) => {
    const groupId = asNumber(params.group_id);

    if (!groupId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'invalid group_id');
    }


    try {
      await ctx.bridge.apis.misc.sendGroupSign(groupId);
      return okResponse({});
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  };

  h.registerAction('set_group_sign', handleGroupSign);
  h.registerAction('send_group_sign', handleGroupSign);

  h.registerAction('get_group_info_ex', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (ctx.getGroupInfo) {
      return okResponse(await ctx.getGroupInfo(groupId));
    }
    return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
  });

  h.registerAction('get_group_detail_info', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (ctx.getGroupInfo) {
      return okResponse(await ctx.getGroupInfo(groupId));
    }
    return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
  });

  h.registerAction('trans_group_file', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });

  h.registerAction('rename_group_file', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });

  h.registerAction('get_file', async (params) => {
    const fileId = asString(params.file_id) || asString(params.file);
    if (!fileId) return failedResponse(RETCODE.BAD_REQUEST, 'file_id is required');
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });

  const handleSendPacket = async (params: JsonObject) => {
    const cmd = asString(params.cmd);
    const dataHex = asString(params.data);
    const rsp = asBoolean(params.rsp, true);
    if (!cmd) return failedResponse(RETCODE.BAD_REQUEST, 'cmd is required');
    if (!/^[0-9a-fA-F]*$/.test(dataHex) || dataHex.length % 2 !== 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'data must be a hex string of even length');
    }
    try {
      const body = hexToBytes(dataHex);
      const result = await ctx.bridge.sendRawPacket(cmd, body);
      if (!result.success) {
        return failedResponse(RETCODE.ACTION_FAILED, result.errorMessage || 'send failed');
      }
      if (!rsp) return okResponse(null);
      const respHex = result.responseData ? bytesToHex(result.responseData) : '';
      return okResponse(respHex);
    } catch (err) {
      return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
    }
  };
  h.registerAction('send_packet', handleSendPacket);
  h.registerAction('.send_packet', handleSendPacket);

  // 机器人生命周期（兼容 NapCat）。
  h.registerAction('bot_exit', async () => {
    setTimeout(() => process.exit(0), 50);
    return okResponse();
  });

  h.registerAction('nc_get_packet_status', async () => {
    return okResponse(null);
  });

  // NapCat 暴露 delete_group_folder。
  // SnowLuma 现有的 delete_group_file_folder 是相同操作。
  // 添加别名以便遵循 NapCat 文档的客户端无需重写载荷。
  h.registerAction('delete_group_folder', async (params) => {
    const groupId = asNumber(params.group_id);
    const folderId = asString(params.folder_id);
    if (!groupId || !folderId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id and folder_id are required');
    }
    await ctx.bridge.apis.groupFile.deleteFolder(groupId, folderId);
    return okResponse();
  });

  // 群待办（oidb 0xF90）。
  // 三个子命令共享相同载荷（群号 + msgSeq）。
  // 这里统一提取一次，并按动作名称分发。
  // msgSeq 来自消息元数据缓存；设置、完成、取消总是指向机器人见过的真实消息。
  type GroupTodoOp = (groupId: number, msgSeq: bigint | number | string) => Promise<void>;
  const handleGroupTodo = (op: GroupTodoOp) => async (params: import('../types').JsonObject) => {
    const groupId = asNumber(params.group_id);
    const messageId = asNumber(params.message_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (!messageId) return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
    const meta = ctx.getMessageMeta(messageId);
    if (!meta) return failedResponse(RETCODE.ACTION_FAILED, 'message not found');
    if (!meta.isGroup || meta.targetId !== groupId) {
      return failedResponse(RETCODE.ACTION_FAILED, 'message does not belong to this group');
    }
    try {
      await op(groupId, BigInt(meta.sequence));
      return okResponse();
    } catch (err) {
      return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
    }
  };
  h.registerAction('set_group_todo', handleGroupTodo((g, s) => ctx.bridge.apis.extras.setGroupTodo(g, BigInt(s))));
  h.registerAction('complete_group_todo', handleGroupTodo((g, s) => ctx.bridge.apis.extras.completeGroupTodo(g, BigInt(s))));
  h.registerAction('cancel_group_todo', handleGroupTodo((g, s) => ctx.bridge.apis.extras.cancelGroupTodo(g, BigInt(s))));

  // 用户在线/扩展状态（NapCat：nc_get_user_status）。

  h.registerAction('nc_get_user_status', async (params) => {
    const userId = asNumber(params.user_id);
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    const status = await ctx.bridge.apis.extras.getStrangerStatus(userId);
    if (!status) return failedResponse(RETCODE.ACTION_FAILED, 'failed to fetch user status');
    return okResponse({ ...status });
  });

  // AI 语音（oidb 0x929D / 0x929B）。

  h.registerAction('get_ai_characters', async (params) => {
    const groupId = asNumber(params.group_id);
    const chatType = asNumber(params.chat_type) || 1;
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    try {
      const list = await ctx.bridge.apis.extras.fetchAiVoiceList(groupId, chatType);
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
  });

  h.registerAction('get_ai_record', async (params) => {
    const groupId = asNumber(params.group_id);
    const character = asString(params.character);
    const text = asString(params.text);
    const chatType = asNumber(params.chat_type) || 1;
    if (!groupId || !character || !text) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id, character and text are required');
    }
    try {
      const node = await ctx.bridge.apis.extras.fetchAiVoice(groupId, character, text, chatType);
      const url = await ctx.bridge.apis.groupFile.getPttUrl(groupId, node);
      return okResponse(url);
    } catch (err) {
      return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
    }
  });

  // NapCat 的 send_group_ai_record 是仅产生副作用的调用。
  // 调用 fetchAiVoice 会把语音发布到群里。
  // 返回的 message_id 始终为 0，因为 oidb 调用不会回显消息 ID。
  h.registerAction('send_group_ai_record', async (params) => {
    const groupId = asNumber(params.group_id);
    const character = asString(params.character);
    const text = asString(params.text);
    const chatType = asNumber(params.chat_type) || 1;
    if (!groupId || !character || !text) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id, character and text are required');
    }
    try {
      await ctx.bridge.apis.extras.fetchAiVoice(groupId, character, text, chatType);
      return okResponse({ message_id: 0 });
    } catch (err) {
      return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
    }
  });

  h.registerAction('request_decrypt_key', async (params) => {
    const dbPath = asString(params.db_path);
    if (!dbPath) {
      return failedResponse(RETCODE.BAD_REQUEST, 'db_path is required');
    }

    try {
      const buffer = Buffer.alloc(128);
      const fileHandle = await readFile(dbPath);

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
