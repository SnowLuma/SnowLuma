/**
 * Plugin global state.
 *
 * 持有配置、日志器和机器人客户端引用，供消息处理器访问。
 * 替代原 NapCat 插件中通过 `ctx` 传递的状态。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
class PluginState {
    /** 当前插件配置 */
    config;
    /** 日志器 */
    logger;
    /** SnowLuma 客户端引用 */
    bot = null;
    /** 机器人自身 QQ（用于转发节点头像） */
    selfId = null;
    constructor(config, logger) {
        this.config = config;
        this.logger = logger;
    }
    /** 绑定客户端与登录信息 */
    bindBot(bot, selfId) {
        this.bot = bot;
        this.selfId = selfId;
    }
    /** 更新部分配置 */
    updateConfig(partial) {
        this.config = { ...this.config, ...partial };
    }
    /** 替换整个配置 */
    replaceConfig(cfg) {
        this.config = cfg;
    }
}
/** 全局单例（在 `initPlugin` 中初始化）。 */
export let pluginState = null;
/** 初始化全局状态。 */
export function initPluginState(config, logger) {
    pluginState = new PluginState(config, logger);
    return pluginState;
}
/** 获取已初始化的状态（消息处理器中使用）。 */
export function getState() {
    if (!pluginState) {
        throw new Error('Plugin state 尚未初始化，请先调用 initPluginState()');
    }
    return pluginState;
}
//# sourceMappingURL=state.js.map