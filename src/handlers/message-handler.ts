/**
 * Message handler — adapted for SnowLuma SDK.
 *
 * 将原 NapCat 的 `ctx.actions.call(...)` 调用迁移到 SnowLuma SDK 的类型化方法：
 *  - send_msg               → bot.sendGroupMessage / bot.sendPrivateMessage
 *  - send_group_forward_msg → bot.sendForwardMessage({ group_id, messages, ...preview })
 *  - send_private_forward_msg → bot.sendForwardMessage({ user_id, messages, ...preview })
 *  - send_forward_msg (兼容回退) → bot.raw('send_forward_msg', { group_id, messages, ...preview })
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Author: 希儿 (shiYuPIay) / SnowLuma 适配
 */

import type { SnowLumaApiClient } from '@snowluma/sdk/client';
import type { AnyMessageSegment, JsonValue, OneBotMessageEvent, OutgoingMessage } from '@snowluma/sdk/types';
import { message } from '@snowluma/sdk/messages';
import { getState } from '../core/state.js';
import { recommendIllusts, searchIllusts, fetchDailyRanking, checkApiHealth } from '../services/pixiv-service.js';
import type { PixivIllust, PixivRankingIllust } from '../types.js';

/** 匿名合并转发配置：使用系统账号头像，减少机器人身份暴露。 */
const ANON_FORWARD_QQ = 10001;
const ANON_FORWARD_NAME = '匿名用户';

/** 每用户上次请求时间，用于限流。 */
const userLastRequestAt = new Map<string, number>();

// ---------------------------------------------------------------------------
// 消息段构造辅助
// ---------------------------------------------------------------------------

function textSegment(text: string): AnyMessageSegment {
  return message.text(text);
}

function imageSegment(url: string): AnyMessageSegment {
  return message.image(url);
}

// ---------------------------------------------------------------------------
// 文本提取 / 限流 / 关键词拦截
// ---------------------------------------------------------------------------

/** 尽量从事件中提取纯文本内容，兼容不同 OneBot 实现。 */
function getPlainText(event: OneBotMessageEvent): string {
  if (typeof event.raw_message === 'string' && event.raw_message.trim()) {
    return event.raw_message.trim();
  }
  const msg = event.message;
  if (typeof msg === 'string') return msg.trim();
  if (Array.isArray(msg)) {
    return msg
      .map((seg) => {
        if (seg === null) return '';
        if (typeof seg === 'string') return seg;
        if (typeof seg === 'object' && 'type' in seg) {
          const s = seg as { type: string; data?: { text?: string } };
          if (s.type === 'text') return String(s.data?.text ?? '');
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

function parseBlockedKeywords(raw: string): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function hitBlockedKeyword(text: string, blocked: string[]): string {
  const normalized = String(text || '').toLowerCase();
  return blocked.find((k) => normalized.includes(k)) ?? '';
}

/** 返回剩余等待秒数；0 表示放行。 */
function checkRateLimit(event: OneBotMessageEvent, seconds: number): number {
  const uid = String(event.user_id || '0');
  const now = Date.now();
  const limitMs = Math.max(3, Number(seconds) || 15) * 1000;
  const last = userLastRequestAt.get(uid) ?? 0;
  if (now - last < limitMs) {
    return Math.ceil((limitMs - (now - last)) / 1000);
  }
  userLastRequestAt.set(uid, now);
  return 0;
}

// ---------------------------------------------------------------------------
// 发送回复（替代 ctx.actions.call('send_msg', ...)）
// ---------------------------------------------------------------------------

/** 根据事件发送回复，自动处理群聊和私聊。 */
async function sendReply(bot: SnowLumaApiClient, event: OneBotMessageEvent, msg: OutgoingMessage): Promise<boolean> {
  try {
    if (event.message_type === 'group') {
      await bot.sendGroupMessage(event.group_id, msg);
    } else {
      await bot.sendPrivateMessage(event.user_id, msg);
    }
    return true;
  } catch (err) {
    getState().logger.error('发送回复失败:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 发送合并转发（替代 ctx.actions.call('send_group_forward_msg', ...)）
// ---------------------------------------------------------------------------

/**
 * 发送合并转发消息。
 *
 * SnowLuma SDK 提供 `sendForwardMessage(params)`，其 params 类型 `ForwardMessageParams`
 * 同时支持 group_id / user_id / messages / message 以及预览字段（prompt/summary/source/news）。
 * 这里优先使用该类型化方法，失败时回退到 `bot.raw('send_forward_msg', ...)`。
 */
async function sendForwardMsg(
  bot: SnowLumaApiClient,
  target: number,
  isGroup: boolean,
  nodes: AnyMessageSegment[],
  preview?: { prompt?: string; summary?: string; source?: string; news?: { text: string }[] },
): Promise<boolean> {
  const logger = getState().logger;

  // 优先：sendForwardMessage（类型化，支持预览字段）
  try {
    await bot.sendForwardMessage({
      ...(isGroup ? { group_id: target } : { user_id: target }),
      messages: nodes as unknown as JsonValue,
      ...preview,
    });
    return true;
  } catch (e1) {
    logger.warn?.('sendForwardMessage 发送失败，尝试 send_group/private_forward_msg 回退:', e1);
  }

  // 回退 1：专用群/私聊转发 action
  const actionName = isGroup ? 'send_group_forward_msg' : 'send_private_forward_msg';
  try {
    await bot.raw(actionName, {
      ...(isGroup ? { group_id: target } : { user_id: target }),
      messages: nodes as unknown as JsonValue,
      ...preview,
    });
    return true;
  } catch (e2) {
    logger.warn?.(`${actionName} 发送失败，尝试 send_forward_msg 回退:`, e2);
  }

  // 回退 2：通用 send_forward_msg，message 字段兼容
  try {
    await bot.raw('send_forward_msg', {
      ...(isGroup ? { group_id: target } : { user_id: target }),
      message: nodes as unknown as JsonValue,
      ...preview,
    });
    return true;
  } catch (e4) {
    logger.error('发送合并转发失败:', e4);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 转发节点构造
// ---------------------------------------------------------------------------

/** 创建一个合并转发节点，用于展示单条插画信息。 */
function buildForwardNode(illust: PixivIllust, isGroup: boolean, botId?: number): AnyMessageSegment {
  const titleLine = `${illust.title} - ${illust.author}`;
  const tagLine = illust.tags.length > 0 ? `标签: ${illust.tags.join(', ')}` : '';
  const content: AnyMessageSegment[] = [
    textSegment(`${titleLine}\n${tagLine}\n`),
    imageSegment(illust.url),
  ];
  const useAnon = isGroup && getState().config.enableAnonymousForward;
  return message.node(
    useAnon ? ANON_FORWARD_QQ : (botId ?? ANON_FORWARD_QQ),
    useAnon ? ANON_FORWARD_NAME : 'PixivBot',
    content,
  );
}

/** 创建日榜合并转发节点。 */
function buildDailyRankingNode(illust: PixivRankingIllust, index: number): AnyMessageSegment {
  const safeTags = Array.isArray(illust.tags) && illust.tags.length > 0 ? illust.tags.join(', ') : '无';
  return message.node(
    ANON_FORWARD_QQ,
    `#${index + 1} ${illust.title}`,
    [
      imageSegment(illust.proxyUrl),
      textSegment(`${illust.title}\n画师: ${illust.author}\nPID: ${illust.id} | ❤️ ${illust.bookmarks}\nTags: ${safeTags}`),
    ],
  );
}

// ---------------------------------------------------------------------------
// 帮助 / 状态文案
// ---------------------------------------------------------------------------

function buildHelpLines(prefix: string): string[] {
  return [
    'Pixiv 插件帮助（SnowLuma 适配版）',
    `${prefix}<关键词> - 搜索含有关键词的插画`,
    `${prefix}rec - 获取随机推荐插画`,
    `${prefix}推荐 - 获取随机推荐插画`,
    `${prefix}日榜 - 查看今日 Pixiv 日榜 Top10`,
    `${prefix}help - 显示本帮助`,
    `${prefix}status - 检查接口连通性`,
    `${prefix}合规 - 查看合规提示`,
  ];
}

// ---------------------------------------------------------------------------
// 主消息处理
// ---------------------------------------------------------------------------

/**
 * 主消息处理函数。由 SnowLuma WebSocket 客户端的 onMessage 事件触发。
 */
export async function handleMessage(bot: SnowLumaApiClient, event: OneBotMessageEvent): Promise<void> {
  try {
    const state = getState();
    if (!state.config.enabled) return;

    const rawMessage = getPlainText(event);
    if (!rawMessage) return;

    const prefix = state.config.commandPrefix || '#pixiv';
    if (!rawMessage.startsWith(prefix)) return;

    const commandText = rawMessage.slice(prefix.length).trim();

    // 无参数 → 帮助
    if (!commandText) {
      await sendReply(bot, event, buildHelpLines(prefix).join('\n'));
      return;
    }

    const normalizedCommand = commandText.replace(/\s+/g, '').toLowerCase();
    const normalizedRawMessage = rawMessage.replace(/\s+/g, '').toLowerCase();

    // 关键词安全拦截
    const blocked = parseBlockedKeywords(state.config.blockedKeywords);
    const hit = hitBlockedKeyword(commandText, blocked);
    if (hit) {
      await sendReply(bot, event, `请求已拒绝：命中安全拦截词「${hit}」。`);
      return;
    }

    // 限流
    const waitSeconds = checkRateLimit(event, state.config.rateLimitSeconds);
    if (waitSeconds > 0) {
      await sendReply(bot, event, `请求过于频繁，请在 ${waitSeconds} 秒后重试。`);
      return;
    }

    // 帮助
    if (normalizedCommand === 'help' || normalizedCommand === '帮助') {
      await sendReply(bot, event, buildHelpLines(prefix).join('\n'));
      return;
    }

    // 合规提示
    if (normalizedCommand === '合规' || normalizedCommand === 'compliance') {
      await sendReply(
        bot,
        event,
        [
          '合规提示：',
          '1) 禁止请求未成年人、暴力或违法内容；',
          '2) 建议关闭匿名转发，保留审计轨迹；',
          '3) 如被举报，请立即停用并导出日志排查。',
        ].join('\n'),
      );
      return;
    }

    // 接口状态检查
    if (normalizedCommand === 'status' || normalizedCommand === '状态' || normalizedCommand === 'ping') {
      const health = await checkApiHealth();
      const lines = [
        'Pixiv 插件状态自检',
        `Lolicon API: ${health.lolicon ? '✅ 可访问' : '❌ 不可访问'}`,
        `Pixiv 日榜 API: ${health.ranking ? '✅ 可访问' : '❌ 不可访问'}`,
        health.lolicon && health.ranking
          ? '总体状态：正常'
          : '总体状态：异常（请检查网络、代理或第三方 API 状态）',
      ];
      await sendReply(bot, event, lines.join('\n'));
      return;
    }

    // Pixiv 日榜（兼容无前缀调用：!pixiv日榜）
    if (normalizedRawMessage === '!pixiv日榜' || normalizedCommand === '日榜' || normalizedCommand === 'daily') {
      await handleDailyRanking(bot, event);
      return;
    }

    const maxResults = Math.min(10, Math.max(1, Number(state.config.maxResults) || 3));
    const allowR18Config = Boolean(state.config.allowR18);
    const allowR18 = event.message_type === 'private' ? allowR18Config : false;

    // 推荐
    if (normalizedCommand === 'rec' || normalizedCommand === '推荐') {
      const illusts = await recommendIllusts(maxResults, allowR18);
      await handleIllustsResult(bot, event, illusts, '未找到推荐插画，请稍后再试。');
      return;
    }

    // 默认：关键词搜索
    const illusts = await searchIllusts(commandText, maxResults, allowR18);
    await handleIllustsResult(bot, event, illusts, `未找到与 "${commandText}" 相关的插画。`);
  } catch (err) {
    getState().logger.error('处理消息时出错:', err);
  }
}

/** 处理搜索/推荐结果：单图直接发送，多图合并转发。 */
async function handleIllustsResult(
  bot: SnowLumaApiClient,
  event: OneBotMessageEvent,
  illusts: PixivIllust[],
  emptyHint: string,
): Promise<void> {
  const state = getState();
  if (illusts.length === 0) {
    await sendReply(bot, event, emptyHint);
    return;
  }

  // 单图直接发送
  if (illusts.length === 1) {
    const illust = illusts[0];
    const segments: AnyMessageSegment[] = [
      textSegment(`${illust.title} - ${illust.author}\n` + (illust.tags.length > 0 ? `标签: ${illust.tags.join(', ')}\n` : '')),
      imageSegment(illust.url),
    ];
    await sendReply(bot, event, segments);
    return;
  }

  // 多图合并转发
  const botId = state.selfId ?? undefined;
  const isGroup = event.message_type === 'group';
  const nodes = illusts.map((i) => buildForwardNode(i, isGroup, botId));
  const target = isGroup ? event.group_id : event.user_id;

  if (state.config.enableForward === false) {
    for (const n of nodes) {
      const nodeData = (n.data as { content: AnyMessageSegment[] }).content;
      await sendReply(bot, event, nodeData);
    }
    return;
  }

  await sendForwardMsg(bot, target, isGroup, nodes, {
    prompt: '[Pixiv推送]',
    summary: `查看${nodes.length}条插画`,
    source: 'Pixiv',
    news: nodes.slice(0, 4).map((_, i) => ({ text: `${ANON_FORWARD_NAME}: 作品 ${i + 1}` })),
  });
}

/** 处理日榜：群聊优先合并转发，私聊/转发失败回退逐条发送。 */
async function handleDailyRanking(bot: SnowLumaApiClient, event: OneBotMessageEvent): Promise<void> {
  const state = getState();
  const rankings = await fetchDailyRanking(10);
  if (rankings.length === 0) {
    await sendReply(bot, event, '暂时无法获取 Pixiv 日榜，请稍后再试。');
    return;
  }

  const nodes = rankings.map((illust, i) => buildDailyRankingNode(illust, i));
  const isGroup = event.message_type === 'group';
  const target = isGroup ? event.group_id : event.user_id;

  if (state.config.enableForward === false) {
    for (const n of nodes) {
      const nodeData = (n.data as { content: AnyMessageSegment[] }).content;
      await sendReply(bot, event, nodeData);
    }
    return;
  }

  await sendForwardMsg(bot, target, isGroup, nodes, {
    news: rankings.slice(0, 3).map((illust, i) => ({ text: `🏆 #${i + 1}: ${illust.title} (${illust.bookmarks} ❤️)` })),
    prompt: '[Pixiv日榜Top10]',
    summary: `查看${rankings.length}张今日排行插画`,
    source: 'Pixiv Daily Ranking',
  });
}

/** 清空限流记录（用于热重载/测试）。 */
export function resetRateLimit(): void {
  userLastRequestAt.clear();
}
