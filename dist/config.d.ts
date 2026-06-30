/**
 * Plugin configuration.
 *
 * SnowLuma 没有内置的 WebUI 配置面板（NapCat 的 `ctx.NapCatConfig`），因此这里改为：
 *  - 文件持久化 `config.json`
 *  - 环境变量覆盖（SNOWLUMA_PIXIV_*）
 *  - 强类型的默认值与字段描述
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Author: 希儿 (shiYuPIay) / SnowLuma 适配
 */
import type { ConfigField, ConfigValidationResult } from './types.js';
/** 默认配置文件相对路径（相对于进程 cwd）。 */
export declare const DEFAULT_CONFIG_PATH = "config.json";
/** 插件运行配置。 */
export interface PluginConfig {
    enabled: boolean;
    commandPrefix: string;
    maxResults: number;
    allowR18: boolean;
    enableForward: boolean;
    enableAnonymousForward: boolean;
    rateLimitSeconds: number;
    blockedKeywords: string;
}
/** SnowLuma 连接配置（来自环境变量或配置文件）。 */
export interface SnowLumaConnectionConfig {
    /** WebSocket 端点，例如 ws://127.0.0.1:3001/ */
    wsUrl: string;
    /** HTTP 端点，例如 http://127.0.0.1:3000/（仅 fallback 使用） */
    httpUrl: string;
    /** OneBot access token */
    accessToken?: string;
    /** 单次请求超时（ms） */
    requestTimeoutMs: number;
    /** 是否启用自动重连 */
    reconnect: boolean;
}
/** 顶层配置 = 插件配置 + 连接配置。 */
export interface RootConfig {
    plugin: PluginConfig;
    connection: SnowLumaConnectionConfig;
}
/** 默认插件配置。 */
export declare function defaultPluginConfig(): PluginConfig;
/** 默认连接配置（与 SnowLuma 默认端口一致）。 */
export declare function defaultConnectionConfig(): SnowLumaConnectionConfig;
/** 配置字段描述（取代 NapCat 的 configSchema，供 WebUI/CLI 展示）。 */
export declare const PLUGIN_CONFIG_FIELDS: ConfigField[];
/** 校验插件配置。 */
export declare function validatePluginConfig(cfg: Partial<PluginConfig>): ConfigValidationResult;
/** 从磁盘加载完整配置（plugin + connection）。 */
export declare function loadConfig(configPath?: string): RootConfig;
/** 将插件配置写回磁盘（用于运行时变更持久化）。 */
export declare function savePluginConfig(cfg: PluginConfig, configPath?: string): void;
/** 生成示例配置文件路径。 */
export declare function exampleConfigPath(): string;
//# sourceMappingURL=config.d.ts.map