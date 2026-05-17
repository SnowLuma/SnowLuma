import { format } from 'util';
import { getFileTransport } from './log-file-transport';

type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
  line: string;
}

interface LogOptions {
  scope: string;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  success: 25,
  warn: 30,
  error: 40,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  success: 'OK',
  warn: 'WARN',
  error: 'ERROR',
};

const COLOR_CODE: Record<LogLevel, number> = {
  debug: 90,
  info: 36,
  success: 32,
  warn: 33,
  error: 31,
};

const COLOR_SCOPE = 35;
const COLOR_DIM = 2;
const COLOR_RESET = '\x1b[0m';
const MAX_LOG_ENTRIES = 1000;
const logEntries: LogEntry[] = [];
const logSubscribers = new Set<(entry: LogEntry) => void>();
let nextLogId = 1;

function resolveMinLevel(): LogLevel {
  const raw = (process.env.SNOWLUMA_LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'success' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

const MIN_LEVEL = resolveMinLevel();

function shouldLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[MIN_LEVEL];
}

function useColor(): boolean {
  if (process.env.NO_COLOR === '1') return false;
  return Boolean(process.stdout.isTTY);
}

function ansi(code: number, text: string): string {
  return `\x1b[${code}m${text}${COLOR_RESET}`;
}

function currentTime(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function render(level: LogLevel, scope: string, args: unknown[]): string {
  const message = format(...args);
  const ts = currentTime();
  const label = LEVEL_LABEL[level].padEnd(5, ' ');

  if (!useColor()) {
    return `${ts} ${label} [${scope}] ${message}`;
  }

  const cTs = ansi(COLOR_DIM, ts);
  const cLabel = ansi(COLOR_CODE[level], label);
  const cScope = ansi(COLOR_SCOPE, `[${scope}]`);
  return `${cTs} ${cLabel} ${cScope} ${message}`;
}

function emit(level: LogLevel, options: LogOptions, args: unknown[]): void {
  // Console / subscriber level filter. File output is debug-and-up always;
  // see log-file-transport.ts.
  const passesConsole = shouldLog(level);
  const message = format(...args);
  const line = render(level, options.scope, args);
  const entry: LogEntry = {
    id: nextLogId++,
    time: new Date().toISOString(),
    level,
    scope: options.scope,
    message,
    line,
  };

  if (passesConsole) {
    logEntries.push(entry);
    if (logEntries.length > MAX_LOG_ENTRIES) logEntries.shift();
    for (const subscriber of logSubscribers) subscriber(entry);
    const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
    // Strip ASCII control characters before writing to terminal to prevent
    // BEL (0x07) in user-provided strings (e.g. group member names) from
    // triggering Windows system beep sounds. ESC (0x1B) is preserved so the
    // ANSI color sequences emitted by render() actually reach the terminal.
    // eslint-disable-next-line no-control-regex
    stream.write(line.replace(/[\x00-\x1A\x1C-\x1F\x7F]/g, '') + '\n');
  }

  // File transport always sees every level (debug-and-up) for post-mortem
  // value; ANSI stripping happens inside the transport.
  getFileTransport().write(line);
}

/**
 * Flush and close the underlying log file. Call from shutdown hooks
 * (SIGINT / SIGTERM / uncaughtException) so the WriteStream's internal
 * buffer makes it to disk. Returns a promise that resolves once the OS
 * has finalized the write.
 */
export function closeLogger(): Promise<void> {
  return getFileTransport().close();
}

export function getRecentLogs(limit = 300): LogEntry[] {
  const n = Math.max(1, Math.min(Math.trunc(limit), MAX_LOG_ENTRIES));
  return logEntries.slice(-n);
}

export function subscribeLogs(callback: (entry: LogEntry) => void): () => void {
  logSubscribers.add(callback);
  return () => {
    logSubscribers.delete(callback);
  };
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  success: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createLogger(scope: string): Logger {
  const options: LogOptions = { scope };
  return {
    debug: (...args: unknown[]) => emit('debug', options, args),
    info: (...args: unknown[]) => emit('info', options, args),
    success: (...args: unknown[]) => emit('success', options, args),
    warn: (...args: unknown[]) => emit('warn', options, args),
    error: (...args: unknown[]) => emit('error', options, args),
  };
}
