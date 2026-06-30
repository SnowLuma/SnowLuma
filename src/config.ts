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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConfigField, ConfigValidationResult } from './types.js';

/** 默认配置文件相对路径（相对于进程 cwd）。 */
export const DEFAULT_CONFIG_PATH = 'config.json';

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
export function defaultPluginConfig(): PluginConfig {
  return {
    enabled: true,
    commandPrefix: '#pixiv',
    maxResults: 3,
    allowR18: false,
    enableForward: true,
    enableAnonymousForward: false,
    rateLimitSeconds: 15,
    blockedKeywords: '萝莉,未成年,幼女,乱伦,强奸',
  };
}

/** 默认连接配置（与 SnowLuma 默认端口一致）。 */
export function defaultConnectionConfig(): SnowLumaConnectionConfig {
  return {
    wsUrl: 'ws://127.0.0.1:3001/',
    httpUrl: 'http://127.0.0.1:3000/',
    accessToken: undefined,
    requestTimeoutMs: 30_000,
    reconnect: true,
  };
}

/** 配置字段描述（取代 NapCat 的 configSchema，供 WebUI/CLI 展示）。 */
export const PLUGIN_CONFIG_FIELDS: ConfigField[] = [
  {
    key: 'enabled',
    label: '启用插件',
    type: 'boolean',
    default: true,
    description: '是否启用 Pixiv 搜索与推荐功能',
  },
  {
    key: 'commandPrefix',
    label: '指令前缀',
    type: 'text',
    default: '#pixiv',
    placeholder: '例如 #pixiv',
    description: '调用本插件的指令前缀',
  },
  {
    key: 'maxResults',
    label: '最大结果数量',
    type: 'number',
    default: 3,
    min: 1,
    max: 10,
    description: '每次搜索或推荐返回图片的最大数量',
  },
  {
    key: 'allowR18',
    label: '允许 R18',
    type: 'boolean',
    default: false,
    description: '是否允许返回 R18 插画（仅私聊生效）',
  },
  {
    key: 'enableForward',
    label: '启用合并转发',
    type: 'boolean',
    default: true,
    description: '是否优先使用合并转发发送多图结果',
  },
  {
    key: 'enableAnonymousForward',
    label: '匿名转发节点',
    type: 'boolean',
    default: false,
    description: '是否使用匿名昵称发送转发节点（默认关闭，便于审计）',
  },
  {
    key: 'rateLimitSeconds',
    label: '用户请求间隔(秒)',
    type: 'number',
    default: 15,
    min: 3,
    max: 300,
    description: '同一用户再次调用指令的最小间隔，防止刷屏',
  },
  {
    key: 'blockedKeywords',
    label: '拦截关键词',
    type: 'text',
    default: '萝莉,未成年,幼女,乱伦,强奸',
    placeholder: '逗号分隔，例如: 违禁词1,违禁词2',
    description: '命中后直接拒绝请求，降低违规风险',
  },
];

/** 校验插件配置。 */
export function validatePluginConfig(cfg: Partial<PluginConfig>): ConfigValidationResult {
  const errors: string[] = [];
  if (cfg.maxResults !== undefined) {
    if (!Number.isFinite(cfg.maxResults) || cfg.maxResults < 1 || cfg.maxResults > 10) {
      errors.push('maxResults 必须为 1~10 之间的整数');
    }
  }
  if (cfg.rateLimitSeconds !== undefined) {
    if (!Number.isFinite(cfg.rateLimitSeconds) || cfg.rateLimitSeconds < 3 || cfg.rateLimitSeconds > 300) {
      errors.push('rateLimitSeconds 必须为 3~300 之间的整数');
    }
  }
  if (cfg.commandPrefix !== undefined && cfg.commandPrefix.trim() === '') {
    errors.push('commandPrefix 不能为空');
  }
  return { ok: errors.length === 0, errors };
}

/** 读取环境变量覆盖（SNOWLUMA_PIXIV_XXX）。 */
function applyEnvOverrides(cfg: PluginConfig): PluginConfig {
  const env = process.env;
  const next = { ...cfg };
  if (env.SNOWLUMA_PIXIV_ENABLED !== undefined) {
    next.enabled = env.SNOWLUMA_PIXIV_ENABLED !== '0' && env.SNOWLUMA_PIXIV_ENABLED.toLowerCase() !== 'false';
  }
  if (env.SNOWLUMA_PIXIV_COMMAND_PREFIX) {
    next.commandPrefix = env.SNOWLUMA_PIXIV_COMMAND_PREFIX;
  }
  if (env.SNOWLUMA_PIXIV_MAX_RESULTS) {
    const n = Number(env.SNOWLUMA_PIXIV_MAX_RESULTS);
    if (Number.isFinite(n)) next.maxResults = n;
  }
  if (env.SNOWLUMA_PIXIV_ALLOW_R18 !== undefined) {
    next.allowR18 = env.SNOWLUMA_PIXIV_ALLOW_R18 === '1' || env.SNOWLUMA_PIXIV_ALLOW_R18.toLowerCase() === 'true';
  }
  if (env.SNOWLUMA_PIXIV_ENABLE_FORWARD !== undefined) {
    next.enableForward = env.SNOWLUMA_PIXIV_ENABLE_FORWARD !== '0' && env.SNOWLUMA_PIXIV_ENABLE_FORWARD.toLowerCase() !== 'false';
  }
  if (env.SNOWLUMA_PIXIV_ENABLE_ANONYMOUS_FORWARD !== undefined) {
    next.enableAnonymousForward = env.SNOWLUMA_PIXIV_ENABLE_ANONYMOUS_FORWARD === '1' || env.SNOWLUMA_PIXIV_ENABLE_ANONYMOUS_FORWARD.toLowerCase() === 'true';
  }
  if (env.SNOWLUMA_PIXIV_RATE_LIMIT_SECONDS) {
    const n = Number(env.SNOWLUMA_PIXIV_RATE_LIMIT_SECONDS);
    if (Number.isFinite(n)) next.rateLimitSeconds = n;
  }
  if (env.SNOWLUMA_PIXIV_BLOCKED_KEYWORDS) {
    next.blockedKeywords = env.SNOWLUMA_PIXIV_BLOCKED_KEYWORDS;
  }
  return next;
}

/** 读取连接配置（主要来自环境变量，便于容器化部署）。 */
function readConnectionConfig(fromFile?: Partial<SnowLumaConnectionConfig>): SnowLumaConnectionConfig {
  const env = process.env;
  const merged: SnowLumaConnectionConfig = {
    ...defaultConnectionConfig(),
    ...(fromFile ?? {}),
  };
  if (env.SNOWLUMA_WS_URL) merged.wsUrl = env.SNOWLUMA_WS_URL;
  if (env.SNOWLUMA_HTTP_URL) merged.httpUrl = env.SNOWLUMA_HTTP_URL;
  if (env.SNOWLUMA_TOKEN) merged.accessToken = env.SNOWLUMA_TOKEN;
  if (env.SNOWLUMA_REQUEST_TIMEOUT_MS) {
    const n = Number(env.SNOWLUMA_REQUEST_TIMEOUT_MS);
    if (Number.isFinite(n)) merged.requestTimeoutMs = n;
  }
  if (env.SNOWLUMA_RECONNECT !== undefined) {
    merged.reconnect = env.SNOWLUMA_RECONNECT !== '0' && env.SNOWLUMA_RECONNECT.toLowerCase() !== 'false';
  }
  return merged;
}

/** 从磁盘加载完整配置（plugin + connection）。 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): RootConfig {
  const pluginDefaults = defaultPluginConfig();
  let fileData: { plugin?: Partial<PluginConfig>; connection?: Partial<SnowLumaConnectionConfig> } | null = null;

  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8');
      fileData = JSON.parse(raw) as { plugin?: Partial<PluginConfig>; connection?: Partial<SnowLumaConnectionConfig> };
    }
  } catch (err) {
    console.warn('[snowluma-plugin-pixiv] 读取配置文件失败，使用默认值:', err);
  }

  const plugin = applyEnvOverrides({
    ...pluginDefaults,
    ...(fileData?.plugin ?? {}),
  });

  const validation = validatePluginConfig(plugin);
  if (!validation.ok) {
    console.warn('[snowluma-plugin-pixiv] 配置校验失败:', validation.errors.join('; '));
  }

  const connection = readConnectionConfig(fileData?.connection);

  return { plugin, connection };
}

/** 将插件配置写回磁盘（用于运行时变更持久化）。 */
export function savePluginConfig(cfg: PluginConfig, configPath: string = DEFAULT_CONFIG_PATH): void {
  try {
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existing: RootConfig = loadConfig(configPath);
    const merged: RootConfig = { ...existing, plugin: cfg };
    writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[snowluma-plugin-pixiv] 保存配置失败:', err);
  }
}

/** 生成示例配置文件路径。 */
export function exampleConfigPath(): string {
  return join(process.cwd(), 'config.example.json');
}
