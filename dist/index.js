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
import { SnowLumaWebSocketClient, } from '@snowluma/sdk';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { initPluginState } from './core/state.js';
import { handleMessage, resetRateLimit } from './handlers/message-handler.js';
/** 从环境变量读取日志级别。 */
function readLogLevel() {
    const lvl = (process.env.SNOWLUMA_PIXIV_LOG_LEVEL ?? 'info').toLowerCase();
    if (lvl === 'debug' || lvl === 'warn' || lvl === 'error')
        return lvl;
    return 'info';
}
/** 构建 SDK 客户端选项。 */
function buildClientOptions(root) {
    const opts = {
        url: root.connection.wsUrl,
        requestTimeoutMs: root.connection.requestTimeoutMs,
        reconnect: root.connection.reconnect,
    };
    if (root.connection.accessToken) {
        opts.accessToken = root.connection.accessToken;
    }
    return opts;
}
/** 主函数。 */
async function main() {
    const configPath = process.env.SNOWLUMA_PIXIV_CONFIG ?? 'config.json';
    const logger = createLogger('PixivPlugin', readLogLevel());
    const root = loadConfig(configPath);
    logger.info('SnowLuma Pixiv 插件启动中…');
    logger.info(`WebSocket 端点: ${root.connection.wsUrl}`);
    logger.info(`指令前缀: ${root.plugin.commandPrefix} | 最大结果: ${root.plugin.maxResults} | 启用转发: ${root.plugin.enableForward}`);
    // 初始化全局状态
    const state = initPluginState(root.plugin, logger);
    // 创建 SnowLuma WebSocket 客户端
    const bot = new SnowLumaWebSocketClient(buildClientOptions(root));
    // 订阅消息事件
    bot.onMessage((event, _ctx) => {
        // 异步处理，避免阻塞事件分发
        void _ctx;
        handleMessage(bot, event).catch((err) => {
            logger.error('onMessage 处理异常:', err);
        });
    });
    // 连接生命周期日志
    bot.on('open', () => logger.info('WebSocket 已连接'));
    bot.on('close', (info) => logger.warn(`WebSocket 已关闭 (code=${info.code} reason=${info.reason ?? ''})`));
    bot.on('error', (err) => logger.error('WebSocket 错误:', err));
    // 优雅退出
    const shutdown = (signal) => {
        logger.info(`收到 ${signal}，正在关闭…`);
        resetRateLimit();
        try {
            bot.close(1000, 'shutdown');
        }
        catch {
            // ignore
        }
        setTimeout(() => process.exit(0), 300);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    // 连接
    try {
        await bot.connect();
    }
    catch (err) {
        logger.error('连接 SnowLuma 失败:', err);
        process.exitCode = 1;
        return;
    }
    // 获取机器人自身信息（用于转发节点头像）
    try {
        const login = await bot.getLoginInfo();
        state.bindBot(bot, login.user_id);
        logger.info(`已登录：${login.nickname} (${login.user_id})`);
    }
    catch (err) {
        logger.warn('获取登录信息失败，转发节点将使用匿名头像:', err);
        state.bindBot(bot, 0);
    }
    logger.info('Pixiv 插件已就绪，等待指令…');
}
// 导出供外部集成/测试使用
export { loadConfig, savePluginConfig } from './config.js';
export { handleMessage, resetRateLimit } from './handlers/message-handler.js';
export { initPluginState, getState } from './core/state.js';
export { createLogger } from './logger.js';
export { PLUGIN_CONFIG_FIELDS } from './config.js';
// 直接运行入口
main().catch((err) => {
    console.error('[snowluma-plugin-pixiv] 致命错误:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map