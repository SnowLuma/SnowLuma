import type { ApiHandler, ApiActionContext } from '../api-handler';
import { asMessage, asNumber, asString, asBoolean } from '../api-handler';
import { RETCODE, failedResponse, okResponse } from '../types';

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  // --- Likes & Pokes ---

  h.registerAction('send_like', async (params) => {
    const userId = asNumber(params.user_id);
    const times = asNumber(params.times) || 1;
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    if (!ctx.sendLike) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.sendLike(userId, times);
    return okResponse();
  });

  h.registerAction('friend_poke', async (params) => {
    const userId = asNumber(params.user_id);
    const targetId = asNumber(params.target_id) || undefined;
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    if (!ctx.sendFriendPoke) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.sendFriendPoke(userId, targetId);
    return okResponse();
  });

  h.registerAction('group_poke', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    if (!ctx.sendGroupPoke) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.sendGroupPoke(groupId, userId);
    return okResponse();
  });

  h.registerAction('send_poke', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    if (groupId) {
      if (!ctx.sendGroupPoke) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
      await ctx.sendGroupPoke(groupId, userId);
    } else {
      if (!ctx.sendFriendPoke) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
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
    if (!ctx.setEssenceMsg) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setEssenceMsg(messageId);
    return okResponse();
  });

  h.registerAction('delete_essence_msg', async (params) => {
    const messageId = asNumber(params.message_id);
    if (!Number.isInteger(messageId) || messageId === 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
    }
    if (!ctx.deleteEssenceMsg) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.deleteEssenceMsg(messageId);
    return okResponse();
  });

  h.registerAction('get_essence_msg_list', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');

    if (!ctx.getGroupEssenceAll) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      const essenceDataAll = await ctx.getGroupEssenceAll(groupId);

      const allMsgs = essenceDataAll.flatMap(res => res.data?.msg_list || []);

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

    if (!ctx.setGroupReaction) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupReaction(meta.targetId, meta.sequence, code, isSet);
    return okResponse();
  });

  // --- History ---

  h.registerAction('get_group_msg_history', async (params) => {
    const groupId = asNumber(params.group_id);
    const messageId = asNumber(params.message_id) || 0;
    const count = asNumber(params.count) || 20;
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (!ctx.getGroupMsgHistory) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    const messages = await ctx.getGroupMsgHistory(groupId, messageId, count);
    return okResponse({ messages });
  });

  h.registerAction('get_friend_msg_history', async (params) => {
    const userId = asNumber(params.user_id);
    const messageId = asNumber(params.message_id) || 0;
    const count = asNumber(params.count) || 20;
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    if (!ctx.getFriendMsgHistory) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
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
    if (!meta) return failedResponse(RETCODE.ACTION_FAILED, 'message not found');

    if (!meta || !meta.isGroup) {
      return failedResponse(RETCODE.ACTION_FAILED, 'message not found or not a group message');
    }

    if (groupId && groupId !== meta.targetId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id does not match message session');
    }

    if (!ctx.markGroupMsgAsRead) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');

    await ctx.markGroupMsgAsRead(groupId, meta.sequence);
    return okResponse();
  });

  h.registerAction('mark_private_msg_as_read', async (params) => {
    const messageId = asNumber(params.message_id);
    const userId = asNumber(params.user_id);

    if (!Number.isInteger(messageId) || messageId === 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
    }
    const meta = ctx.getMessageMeta(messageId);
    if (!meta) return failedResponse(RETCODE.ACTION_FAILED, 'message not found');

    if (!meta || meta.isGroup) {
      return failedResponse(RETCODE.ACTION_FAILED, 'message not found or not a private message');
    }

    if (userId && userId !== meta.targetId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'user_id does not match message session');
    }

    if (!ctx.markPrivateMsgAsRead) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');

    await ctx.markPrivateMsgAsRead(userId, meta.sequence);
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

    if (!(ctx.markPrivateMsgAsRead && ctx.markGroupMsgAsRead)) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');

    if (meta.isGroup) {
      await ctx.markGroupMsgAsRead(targetId, meta.sequence);
    } else {
      await ctx.markPrivateMsgAsRead(targetId, meta.sequence);
    }
    return okResponse();
  });


  // --- RKey ---

  h.registerAction('get_rkey', async () => {
    if (ctx.getDownloadRKeys) {
      return okResponse(await ctx.getDownloadRKeys());
    }
    return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
  });

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

    if (!ctx.sendGroupNotice) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      const options = {
        image: image || undefined,
        pinned: params.pinned !== undefined ? Number(params.pinned) : 0,
        type: params.type !== undefined ? Number(params.type) : 1,
        confirm_required: params.confirm_required !== undefined ? Number(params.confirm_required) : 1,
      };

      await ctx.sendGroupNotice(groupId, content, options);
      return okResponse();
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('_get_group_notice', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');

    if (!ctx.getGroupNotice) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      const notices = await ctx.getGroupNotice(groupId);
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

    if (!ctx.deleteGroupNotice) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      const success = await ctx.deleteGroupNotice(groupId, fid);
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
    if (!ctx.sendForwardMsg) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');

    const result = await ctx.sendForwardMsg(messages);
    const data: Record<string, unknown> = {
      res_id: result.forwardId,
      forward_id: result.forwardId,
      message_id: 0,
    };
    if (groupId > 0) data.group_id = groupId;
    return okResponse(data as any);
  });

  h.registerAction('upload_foward_msg', async (params) => {
    const messages = asMessage(params.messages ?? params.message);
    if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');
    if (!ctx.sendForwardMsg) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    const result = await ctx.sendForwardMsg(messages);
    return okResponse({ res_id: result.forwardId, forward_id: result.forwardId, message_id: 0 });
  });

  h.registerAction('send_forward_msg', async (params) => {
    const messageType = asString(params.message_type);
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    const messages = asMessage(params.messages ?? params.message);

    if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');

    if ((messageType === 'group' || groupId > 0) && ctx.sendGroupForwardMsg) {
      if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
      const result = await ctx.sendGroupForwardMsg(groupId, messages);
      return okResponse({ message_id: result.messageId, res_id: result.forwardId, forward_id: result.forwardId });
    }

    if ((messageType === 'private' || userId > 0) && ctx.sendPrivateForwardMsg) {
      if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
      const result = await ctx.sendPrivateForwardMsg(userId, messages);
      return okResponse({ message_id: result.messageId, res_id: result.forwardId, forward_id: result.forwardId });
    }

    if (!ctx.sendForwardMsg) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    const result = await ctx.sendForwardMsg(messages);
    return okResponse({ message_id: 0, res_id: result.forwardId, forward_id: result.forwardId });
  });

  h.registerAction('send_group_forward_msg', async (params) => {
    const groupId = asNumber(params.group_id);
    const messages = asMessage(params.messages ?? params.message);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');
    if (!ctx.sendGroupForwardMsg) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');

    const result = await ctx.sendGroupForwardMsg(groupId, messages);
    return okResponse({ message_id: result.messageId, res_id: result.forwardId, forward_id: result.forwardId });
  });

  h.registerAction('send_private_forward_msg', async (params) => {
    const userId = asNumber(params.user_id);
    const messages = asMessage(params.messages ?? params.message);
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    if (messages === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'message/messages is required');
    if (!ctx.sendPrivateForwardMsg) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');

    const result = await ctx.sendPrivateForwardMsg(userId, messages);
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
    if (!ctx.getForwardMsg) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');

    const messages = await ctx.getForwardMsg(id);
    return okResponse({ messages });
  });

  // --- Media ---

  h.registerAction('get_image', async (params) => {
    const file = asString(params.file) || asString(params.file_id);
    if (!file) return failedResponse(RETCODE.BAD_REQUEST, 'file is required');
    if (!ctx.getImageInfo) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    const info = await ctx.getImageInfo(file);
    if (info) return okResponse(info);
    return failedResponse(RETCODE.ACTION_FAILED, 'image not found in cache');
  });

  h.registerAction('get_record', async (params) => {
    const file = asString(params.file) || asString(params.file_id);
    if (!file) return failedResponse(RETCODE.BAD_REQUEST, 'file is required');
    if (!ctx.getRecordInfo) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    const info = await ctx.getRecordInfo(file);
    if (info) return okResponse(info);
    return failedResponse(RETCODE.ACTION_FAILED, 'record not found in cache');
  });

  // --- Credentials ---

  h.registerAction('get_cookies', async (params) => {
    const domain = asString(params.domain) || 'qun.qq.com';

    if (!ctx.getCookiesStr) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');

    try {
      const cookies = await ctx.getCookiesStr(domain);
      return okResponse({ cookies });
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_csrf_token', async () => {
    if (!ctx.getCsrfToken) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');

    try {
      const token = await ctx.getCsrfToken();
      return okResponse({ token });
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_credentials', async (params) => {
    const domain = asString(params.domain) || 'qun.qq.com';

    if (!ctx.getCredentials) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');

    try {
      const creds = await ctx.getCredentials(domain);
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
    const remark = asString(params.remark) ?? '';
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    if (!ctx.setFriendRemark) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setFriendRemark(userId, remark);
    return okResponse();
  });

  h.registerAction('set_group_remark', async (params) => {
    const groupId = asNumber(params.group_id);
    const remark = asString(params.remark) ?? '';
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (!ctx.setGroupRemark) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupRemark(groupId, remark);
    return okResponse();
  });

  h.registerAction('set_msg_emoji_like', async (params) => {
    const messageId = asNumber(params.message_id);
    const emojiId = asString(params.emoji_id);
    const set = asBoolean(params.set, true);
    if (!Number.isInteger(messageId) || messageId === 0 || !emojiId) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message_id and emoji_id are required');
    }
    if (!ctx.setMsgEmojiLike) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
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
    const tempDir = pathMod.join('data', 'downloads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    let filePath: string;
    if (base64) {
      const buf = Buffer.from(base64, 'base64');
      const fileName = name || cryptoMod.createHash('md5').update(buf).digest('hex');
      filePath = pathMod.join(tempDir, fileName);
      fs.writeFileSync(filePath, buf);
    } else {
      const response = await fetch(url!, {
        headers: parseDownloadHeaders(params.headers),
      });
      if (!response.ok) return failedResponse(RETCODE.ACTION_FAILED, `download failed: ${response.status}`);
      const buf = Buffer.from(await response.arrayBuffer());
      const fileName = name || cryptoMod.createHash('md5').update(buf).digest('hex');
      filePath = pathMod.join(tempDir, fileName);
      fs.writeFileSync(filePath, buf);
    }
    return okResponse({ file: pathMod.resolve(filePath) });
  });

  h.registerAction('set_qq_profile', async (params) => {

    const nickname = params.nickname !== undefined ? asString(params.nickname) : undefined;
    const personalNote = params.personal_note !== undefined ? asString(params.personal_note) : undefined;

    if (!ctx.setProfile) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      await ctx.setProfile(nickname, personalNote);
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

    if (!ctx.setOnlineStatus) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      await ctx.setOnlineStatus(status, extStatus, batteryStatus);
      return okResponse();
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_group_ignored_notifies', async () => {
    return okResponse([]);
  });

  h.registerAction('get_group_shut_list', async () => {
    return okResponse([]);
  });

  h.registerAction('forward_friend_single_msg', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });

  h.registerAction('forward_group_single_msg', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });

  // todo 我的建议是引入数据库api   纯协议我不知道这种api怎么实现，ntQQ在实现这个方法的时候只进行了数据库查询，完全没碰网络
  h.registerAction('get_recent_contact', async () => {
    return okResponse([]);
  });

  h.registerAction('get_profile_like', async (params) => {
    const userId = asNumber(params.user_id);
    const start = asNumber(params.start) || 0;
    const count = asNumber(params.count) || 10;

    if (!ctx.getProfileLike) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      const data = await ctx.getProfileLike(userId, start, count);
      return okResponse(data);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('fetch_custom_face', async (params) => {
    const count = asNumber(params.count) || 10;
    if (!ctx.fetchCustomFace) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }
    try {
      const urls = await ctx.fetchCustomFace(count);
      return okResponse(urls);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_emoji_likes', async (params) => {
    const messageId = asNumber(params.message_id);
    const emojiId = asString(params.emoji_id) || '';
    if (!messageId || !emojiId) return failedResponse(RETCODE.BAD_REQUEST, 'message_id and emoji_id are required');
    if (!ctx.getEmojiLikes) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    try {
      const meta = ctx.getMessageMeta(messageId);
      if (!meta?.isGroup || !meta?.sequence) return failedResponse(RETCODE.BAD_REQUEST, 'message not found or not a group message');
      const result = await ctx.getEmojiLikes(meta.targetId, meta.sequence, emojiId);
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
    if (!ctx.getEmojiLikes) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    try {
      const meta = ctx.getMessageMeta(messageId);
      if (!meta?.isGroup || !meta?.sequence) return failedResponse(RETCODE.BAD_REQUEST, 'message not found or not a group message');
      const result = await ctx.getEmojiLikes(meta.targetId, meta.sequence, emojiId, emojiType, count, cookie);
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

    if (!ctx.getGroupAtAllRemain) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      const data = await ctx.getGroupAtAllRemain(groupId);
      return okResponse(data);
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_unidirectional_friend_list', async () => {
    if (!ctx.getUnidirectionalFriendList) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      const data = await ctx.getUnidirectionalFriendList();
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

    if (!ctx.setSelfLongNick) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      await ctx.setSelfLongNick(longNick);
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

    if (!ctx.setAvatar) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      await ctx.setAvatar(file);
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

    if (!ctx.setInputStatus) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      await ctx.setInputStatus(userId, eventType);
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

    if (!ctx.translateEn2Zh) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      const translated = await ctx.translateEn2Zh(words);
      return okResponse({ words: translated });
    } catch (e) {
      return failedResponse(RETCODE.ACTION_FAILED, String(e));
    }
  });

  h.registerAction('get_clientkey', async () => {
    if (!ctx.forceFetchClientKey) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
    }
    const clientKeyInfo = await ctx.forceFetchClientKey();
    if (!clientKeyInfo.clientKey) {
      return failedResponse(RETCODE.ACTION_FAILED, 'get clientkey error');
    }
    return okResponse(clientKeyInfo);
  });

  h.registerAction('get_mini_app_ark', async (params) => {
    const type = params.type || 'bili';
    const title = params.title || '';
    const desc = params.desc || '';
    const picUrl = params.picUrl || params.pic_url || '';
    const jumpUrl = params.jumpUrl || params.jump_url || '';

    if (!ctx.getMiniAppArk) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      const data = await ctx.getMiniAppArk(
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

    if (!ctx.clickInlineKeyboardButton) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      const data = await ctx.clickInlineKeyboardButton(
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

    if (!ctx.sendGroupSign) {
      return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    }

    try {
      await ctx.sendGroupSign(groupId);
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

  h.registerAction('.send_packet', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });
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
