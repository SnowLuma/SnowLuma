import type { ApiActionContext, ApiHandler } from '../api-handler';
import { asBoolean, asMessage, asNumber, asString } from '../api-handler';
import type { ForwardPreviewMeta } from '../modules/message-actions';
import { RETCODE, failedResponse, okResponse } from '../types';

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

  // Stream so a server that omits / understates Content-Length can't make
  // us buffer past maxBytes — abort the read as soon as the running total
  // crosses the cap.
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

/**
 * Pull NapCat-compatible forward preview overrides off a send_*_forward_msg
 * payload. All four fields are optional — when omitted, the module layer
 * derives sensible defaults from the actual node list.
 */
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
  // --- Likes & Pokes ---

  h.registerAction('send_like', async (params) => {
    const userId = asNumber(params.user_id);
    const times = asNumber(params.times) || 1;
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    await ctx.bridge.apis.interaction.sendLike(userId, times);
    return okResponse();
  });

  h.registerAction('friend_poke', async (params) => {
    const userId = asNumber(params.user_id);
    const targetId = asNumber(params.target_id) || undefined;
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    await ctx.sendFriendPoke(userId, targetId);
    return okResponse();
  });

  h.registerAction('group_poke', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    await ctx.sendGroupPoke(groupId, userId);
    return okResponse();
  });

  h.registerAction('send_poke', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    if (groupId) {
      await ctx.sendGroupPoke(groupId, userId);
    } else {
      await ctx.sendFriendPoke(userId);
    }
    return okResponse();
  });

  // --- Essence ---

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
      const essenceDataAll = await ctx.bridge.getGroupEssenceAll(groupId);

      const allMsgs = essenceDataAll.flatMap((res: any) => res.data?.msg_list || []);

      return okResponse(allMsgs);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, `获取精华消息失败: ${e}`);
    }
  });

  // --- Reactions ---

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

  // --- History ---

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


  // --- RKey ---

  const handleGetRkey = async () => {
    if (ctx.getDownloadRKeys) {
      return okResponse(await ctx.getDownloadRKeys());
    }
    return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
  };
  h.registerAction('get_rkey', handleGetRkey);
  // napcat exposes the same payload under `nc_get_rkey`; mirror the alias
  // so clients that follow napcat's docs work out-of-the-box.
  h.registerAction('nc_get_rkey', handleGetRkey);

  // --- OCR stubs ---

  h.registerAction('ocr_image', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });

  h.registerAction('.ocr_image', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });

  // --- Group notice stubs ---

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

      await ctx.bridge.sendGroupNotice(groupId, content, options);
      return okResponse();
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('_get_group_notice', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');


    try {
      const notices = await ctx.bridge.getGroupNotice(groupId);
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
      const success = await ctx.bridge.deleteGroupNotice(groupId, fid);
      if (success) {
        return okResponse();
      } else {
        return failedResponse(RETCODE.ACTION_FAILED, 'delete failed');
      }
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  // --- Forward messages ---

  h.registerAction('upload_forward_msg', async (params) => {
    const messages = asMessage(params.messages ?? params.message);
    const groupId = asNumber(params.group_id);
    if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');

    // Group and private forwards live in different resId namespaces
    // (see bridge/actions/forward.ts: type=3+groupUin vs type=1+selfUid).
    // Passing groupId through is what makes the resulting resId usable
    // when the caller later sends it into the same group.
    const result = await ctx.sendForwardMsg(messages, groupId > 0 ? groupId : undefined);
    const data: Record<string, unknown> = {
      res_id: result.forwardId,
      forward_id: result.forwardId,
      message_id: 0,
    };
    if (groupId > 0) data.group_id = groupId;
    return okResponse(data as any);
  });

  // Kept for backward compat with clients that follow the historical
  // gocqhttp/NapCat docs misspelling; same semantics as upload_forward_msg.
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

  // --- Media ---

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

  // --- Credentials ---

  h.registerAction('get_cookies', async (params) => {
    const domain = asString(params.domain) || 'qun.qq.com';


    try {
      const cookies = await ctx.bridge.getCookiesStr(domain);
      return okResponse({ cookies });
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_csrf_token', async () => {

    try {
      const token = await ctx.bridge.getCsrfToken();
      return okResponse({ token });
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_credentials', async (params) => {
    const domain = asString(params.domain) || 'qun.qq.com';


    try {
      const creds = await ctx.bridge.getCredentials(domain);
      return okResponse(creds);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });
  // --- Utility ---

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

  // --- NapCat-compatible extended APIs ---

  h.registerAction('set_friend_remark', async (params) => {
    const userId = asNumber(params.user_id);
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    // remark must be explicitly provided. Falling back to '' on a missing
    // field would silently CLEAR the operator's existing remark.
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
    if (ctx.getGroupFileCount) {
      const info = await ctx.getGroupFileCount(groupId);
      return okResponse({
        file_count: info.fileCount,
        limit_count: info.maxCount,
        used_space: 0,
        total_space: 10737418240,
      });
    }
    return okResponse({
      file_count: 0,
      limit_count: 10000,
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

    // Sanitize file name: strip any path components, reject anything that
    // resolves outside `tempDir`. Without this guard, `name = "../../config/onebot_x.json"`
    // would let an authenticated OneBot client overwrite arbitrary files
    // (config / dist / node_modules) under the working directory.
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
      // Every 4 base64 chars decode to at most 3 bytes. Reject before
      // `Buffer.from` allocates anything to avoid OOM on a giant payload
      // that wouldn't pass the post-decode check anyway.
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
    // Async write so we don't block the event loop on a GiB-class download
    // (the prior `writeFileSync` stalled every other bot action while it ran).
    await fs.promises.writeFile(safe, buf);
    return okResponse({ file: safe });
  });

  h.registerAction('set_qq_profile', async (params) => {

    const nickname = params.nickname !== undefined ? asString(params.nickname) : undefined;
    const personalNote = params.personal_note !== undefined ? asString(params.personal_note) : undefined;


    try {
      await ctx.bridge.setProfile(nickname, personalNote);
      return okResponse();
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('set_online_status', async (params) => {
    // 按 OneBot/NapCat 习惯提取参数，状态码默认为 11
    const status = asNumber(params.status);
    const extStatus = asNumber(params.ext_status) || 0;
    const batteryStatus = asNumber(params.battery_status) || 100;

    // 参数校验
    if (status === undefined || status === 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'status is required');
    }


    try {
      await ctx.bridge.setOnlineStatus(status, extStatus, batteryStatus);
      return okResponse();
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  // DIY status — same wire packet as set_online_status, only the
  // customExt sub-message is populated and status/extStatus are forced
  // to the QQ-defined "I have a custom status" values (10 / 2000).
  // face_id / face_type accept either number or numeric string (napcat
  // parity); wording is the human-readable text shown next to the icon.
  h.registerAction('set_diy_online_status', async (params) => {
    const faceId = asNumber(params.face_id);
    const faceType = asNumber(params.face_type) || 1;
    const wording = asString(params.wording);
    if (!faceId) return failedResponse(RETCODE.BAD_REQUEST, 'face_id is required');
    try {
      await ctx.bridge.setDiyOnlineStatus(faceId, wording, faceType);
      return okResponse();
    } catch (err) {
      return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
    }
  });

  // Filtered (机器人/被忽略) group join requests. SnowLuma already
  // implements the underlying oidb 0x10c8_2 fetch via fetchGroupRequests;
  // these three actions just rename / project the same data for the
  // OneBot dialects clients use in the wild.
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

  // napcat name for the subset of ignored notifies that are join requests
  // (notify type==7). We map every entry that flowed through filtered
  // 0x10c8_2 into napcat's shape — eventType already encodes the request
  // category in our pipeline.
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

  // get_group_shut_list lives behind an oidb we don't yet wrap; honour
  // the napcat contract (empty list) so callers don't blow up.
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

  // todo 我的建议是引入数据库api   纯协议我不知道这种api怎么实现，ntQQ在实现这个方法的时候只进行了数据库查询，完全没碰网络
  h.registerAction('get_recent_contact', async () => {
    return okResponse([]);
  });

  h.registerAction('get_profile_like', async (params) => {
    const userId = asNumber(params.user_id);
    const start = asNumber(params.start) || 0;
    const count = asNumber(params.count) || 10;


    try {
      const data = await ctx.getProfileLike(userId, start, count);
      return okResponse(data);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('fetch_custom_face', async (params) => {
    const count = asNumber(params.count) || 10;
    try {
      const urls = await ctx.bridge.fetchCustomFace(count);
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
      const meta = ctx.getMessageMeta(messageId);
      if (!meta?.isGroup || !meta?.sequence) return failedResponse(RETCODE.BAD_REQUEST, 'message not found or not a group message');
      const result = await ctx.bridge.apis.interaction.getEmojiLikes(meta.targetId, meta.sequence, emojiId);
      return okResponse({ emoji_like_list: result.users.map(u => ({ user_id: String(u.uin), nick_name: '' })) });
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('fetch_emoji_like', async (params) => {
    const messageId = asNumber(params.message_id);
    const emojiId = asString(params.emojiId) || '';
    const emojiType = asNumber(params.emojiType) || 1;
    const count = asNumber(params.count) || 10;
    const cookie = asString(params.cookie) || '';
    if (!messageId || !emojiId) return failedResponse(RETCODE.BAD_REQUEST, 'message_id and emojiId are required');
    try {
      const meta = ctx.getMessageMeta(messageId);
      if (!meta?.isGroup || !meta?.sequence) return failedResponse(RETCODE.BAD_REQUEST, 'message not found or not a group message');
      const result = await ctx.bridge.apis.interaction.getEmojiLikes(meta.targetId, meta.sequence, emojiId, emojiType, count, cookie);
      return okResponse({
        result: 0,
        errMsg: '',
        emojiLikesList: result.users.map(u => ({ tinyId: String(u.uin), nickName: '', headUrl: '' })),
        cookie: result.cookie,
        isLastPage: result.isLast,
        isFirstPage: !cookie,
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

  // --- Additional NapCat-compatible stubs ---

  ///napcat 似乎也用不了？？，暂时不管了
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
      const data = await ctx.bridge.getUnidirectionalFriendList();
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
      await ctx.bridge.setSelfLongNick(longNick);
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
      await ctx.bridge.setAvatar(file);
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
      await ctx.bridge.setInputStatus(userId, eventType);
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
      const translated = await ctx.bridge.translateEn2Zh(words);
      return okResponse({ words: translated });
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_clientkey', async () => {
    const clientKeyInfo = await ctx.bridge.forceFetchClientKey();
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
      const data = await ctx.bridge.getMiniAppArk(
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
      const data = await ctx.bridge.clickInlineKeyboardButton(
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

  const handleGroupSign = async (params: any) => {
    const groupId = asNumber(params.group_id);

    if (!groupId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'invalid group_id');
    }


    try {
      await ctx.bridge.sendGroupSign(groupId);
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

  // --- Raw packet escape hatch (napcat parity) ---
  //
  // napcat exposes both names; the dot-prefix variant is the original
  // gocqhttp-era backdoor, the no-prefix one is the modern API. They do
  // the same thing in SnowLuma: encode hex → Bridge.sendRawPacket → hex.
  const handleSendPacket = async (params: import('../types').JsonObject) => {
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

  // --- Bot lifecycle (napcat parity) ---

  h.registerAction('bot_exit', async () => {
    // Defer so the OK response actually flushes before the process dies.
    setTimeout(() => process.exit(0), 50);
    return okResponse();
  });

  // SnowLuma has no separate packet-backend process (napcat's packet
  // service runs out-of-process and can fail independently). Always
  // report healthy.
  h.registerAction('nc_get_packet_status', async () => {
    return okResponse(null);
  });

  // napcat exposes `delete_group_folder`; SnowLuma's existing
  // `delete_group_file_folder` is the same operation. Alias so clients
  // following napcat docs work without rewriting payloads.
  h.registerAction('delete_group_folder', async (params) => {
    const groupId = asNumber(params.group_id);
    const folderId = asString(params.folder_id);
    if (!groupId || !folderId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id and folder_id are required');
    }
    await ctx.bridge.apis.groupFile.deleteFolder(groupId, folderId);
    return okResponse();
  });

  // --- Group todo (oidb 0xF90) ---
  //
  // The three subcommands share an identical payload (group + msgSeq);
  // we extract once and dispatch by action name. msgSeq comes from the
  // message metadata cache (set/complete/cancel always target a real
  // message the bot has seen).
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
  h.registerAction('set_group_todo', handleGroupTodo((g, s) => ctx.bridge.setGroupTodo(g, s)));
  h.registerAction('complete_group_todo', handleGroupTodo((g, s) => ctx.bridge.completeGroupTodo(g, s)));
  h.registerAction('cancel_group_todo', handleGroupTodo((g, s) => ctx.bridge.cancelGroupTodo(g, s)));

  // --- User online/ext status (napcat: nc_get_user_status) ---

  h.registerAction('nc_get_user_status', async (params) => {
    const userId = asNumber(params.user_id);
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    const status = await ctx.bridge.getStrangerStatus(userId);
    if (!status) return failedResponse(RETCODE.ACTION_FAILED, 'failed to fetch user status');
    return okResponse(status);
  });

  // --- AI voice (oidb 0x929D / 0x929B) ---

  h.registerAction('get_ai_characters', async (params) => {
    const groupId = asNumber(params.group_id);
    const chatType = asNumber(params.chat_type) || 1;
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    try {
      const list = await ctx.bridge.fetchAiVoiceList(groupId, chatType);
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
      const node = await ctx.bridge.fetchAiVoice(groupId, character, text, chatType);
      const url = await ctx.bridge.apis.groupFile.getPttUrl(groupId, node);
      return okResponse(url);
    } catch (err) {
      return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
    }
  });

  // napcat's send_group_ai_record is a side-effect-only call: invoking
  // fetchAiVoice publishes the voice into the group; the returned
  // message_id is always 0 because the oidb call doesn't echo one back.
  h.registerAction('send_group_ai_record', async (params) => {
    const groupId = asNumber(params.group_id);
    const character = asString(params.character);
    const text = asString(params.text);
    const chatType = asNumber(params.chat_type) || 1;
    if (!groupId || !character || !text) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id, character and text are required');
    }
    try {
      await ctx.bridge.fetchAiVoice(groupId, character, text, chatType);
      return okResponse({ message_id: 0 });
    } catch (err) {
      return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
    }
  });
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(buf: Buffer | Uint8Array): string {
  const arr = buf instanceof Buffer ? buf : Buffer.from(buf);
  return arr.toString('hex');
}

/**
 * Parse download_file headers parameter into a Record.
 */
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
