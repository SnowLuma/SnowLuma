/**
 * Lightweight leveled logger.
 *
 * SnowLuma SDK 不提供 logger（NapCat 通过 `ctx.logger` 注入），这里实现一个
 * 兼容 console 的带级别日志器，保持与原插件一致的调用方式（info/warn/error/debug）。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    child(scope: string): Logger;
    level: LogLevel;
}
export declare function createLogger(scope?: string, minLevel?: LogLevel): Logger;
//# sourceMappingURL=logger.d.ts.map