/**
 * Lightweight leveled logger.
 *
 * SnowLuma SDK 不提供 logger（NapCat 通过 `ctx.logger` 注入），这里实现一个
 * 兼容 console 的带级别日志器，保持与原插件一致的调用方式（info/warn/error/debug）。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
const LEVEL_PRIORITY = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
const LEVEL_COLOR = {
    debug: '\x1b[90m',
    info: '\x1b[36m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
};
const RESET = '\x1b[0m';
export function createLogger(scope = 'PixivPlugin', minLevel = 'info') {
    const log = (level, args) => {
        if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel])
            return;
        const ts = new Date().toISOString();
        const prefix = `${LEVEL_COLOR[level]}[${ts}] [${level.toUpperCase()}] [${scope}]${RESET}`;
        console[level === 'debug' ? 'log' : level](prefix, ...args);
    };
    const api = {
        level: minLevel,
        debug: (...args) => log('debug', args),
        info: (...args) => log('info', args),
        warn: (...args) => log('warn', args),
        error: (...args) => log('error', args),
        child: (sub) => createLogger(`${scope}:${sub}`, minLevel),
    };
    return api;
}
//# sourceMappingURL=logger.js.map