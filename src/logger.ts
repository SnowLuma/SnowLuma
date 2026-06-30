/**
 * Lightweight leveled logger.
 *
 * SnowLuma SDK 不提供 logger（NapCat 通过 `ctx.logger` 注入），这里实现一个
 * 兼容 console 的带级别日志器，保持与原插件一致的调用方式（info/warn/error/debug）。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET = '\x1b[0m';

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
  level: LogLevel;
}

export function createLogger(scope = 'PixivPlugin', minLevel: LogLevel = 'info'): Logger {
  const log = (level: LogLevel, args: unknown[]) => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;
    const ts = new Date().toISOString();
    const prefix = `${LEVEL_COLOR[level]}[${ts}] [${level.toUpperCase()}] [${scope}]${RESET}`;
    console[level === 'debug' ? 'log' : level](prefix, ...args);
  };

  const api: Logger = {
    level: minLevel,
    debug: (...args: unknown[]) => log('debug', args),
    info: (...args: unknown[]) => log('info', args),
    warn: (...args: unknown[]) => log('warn', args),
    error: (...args: unknown[]) => log('error', args),
    child: (sub: string) => createLogger(`${scope}:${sub}`, minLevel),
  };
  return api;
}
