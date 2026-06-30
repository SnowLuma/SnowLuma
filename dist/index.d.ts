/**
 * SnowLuma Pixiv Plugin — 主入口
 *
 * 将原 NapCat 进程内插件（plugin_init / plugin_onmessage 生命周期）改造为
 * 基于 @snowluma/sdk 的独立 OneBot v11 客户端：
 *
 *   loadConfig()
 *     → createWebSocketClient({ url, accessToken, reconnect })
 *       → bot.onMessage((event) => handleMessage(bot, event))
 *         → bot.connect()
 *           → getLoginInfo() 获取 self_id 用于转发节点
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Author: 希儿 (shiYuPIay) / SnowLuma 适配
 */
export { loadConfig, savePluginConfig } from './config.js';
export { handleMessage, resetRateLimit } from './handlers/message-handler.js';
export { initPluginState, getState } from './core/state.js';
export { createLogger } from './logger.js';
export { PLUGIN_CONFIG_FIELDS } from './config.js';
export type { RootConfig, PluginConfig, SnowLumaConnectionConfig } from './config.js';
export type { PixivIllust, PixivRankingIllust, ApiHealth } from './types.js';
//# sourceMappingURL=index.d.ts.map