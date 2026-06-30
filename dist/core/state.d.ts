/**
 * Plugin global state.
 *
 * 持有配置、日志器和机器人客户端引用，供消息处理器访问。
 * 替代原 NapCat 插件中通过 `ctx` 传递的状态。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { SnowLumaApiClient } from '@snowluma/sdk';
import type { PluginConfig } from '../config.js';
import type { Logger } from '../logger.js';
declare class PluginState {
    /** 当前插件配置 */
    config: PluginConfig;
    /** 日志器 */
    logger: Logger;
    /** SnowLuma 客户端引用 */
    bot: SnowLumaApiClient | null;
    /** 机器人自身 QQ（用于转发节点头像） */
    selfId: number | null;
    constructor(config: PluginConfig, logger: Logger);
    /** 绑定客户端与登录信息 */
    bindBot(bot: SnowLumaApiClient, selfId: number): void;
    /** 更新部分配置 */
    updateConfig(partial: Partial<PluginConfig>): void;
    /** 替换整个配置 */
    replaceConfig(cfg: PluginConfig): void;
}
/** 全局单例（在 `initPlugin` 中初始化）。 */
export declare let pluginState: PluginState | null;
/** 初始化全局状态。 */
export declare function initPluginState(config: PluginConfig, logger: Logger): PluginState;
/** 获取已初始化的状态（消息处理器中使用）。 */
export declare function getState(): PluginState;
export {};
//# sourceMappingURL=state.d.ts.map