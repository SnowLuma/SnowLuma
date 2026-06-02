import { format } from 'util';
import { getFileTransport } from './log-file-transport';
import { currentRequestId } from './request-context';

type LogLevel = 'trace' | 'debug' | 'info' | 'success' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  scope: string;
  /** QQ uin, when the source logger was derived via `.child({ uin })`. */
  uin?: number;
  /** Correlation id, when emitted inside a `runWithRequestId(...)` scope. */
  req?: number;
  message: string;
  line: string;
}

interface LogOptions {
  scope: string;
  uin?: number;
  /** Free-form meta carried across `.child(...)` calls. Currently only
   *  `uin` is rendered, but the bag is preserved for future fields
   *  (requestId / traceId / etc.). */
  meta?: Record<string, unknown>;
}

const UIN_SLOT_WIDTH = 12;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 5,
  debug: 10,
  info: 20,
  success: 25,
  warn: 30,
  error: 40,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  success: 'OK',
  warn: 'WARN',
  error: 'ERROR',
};

const COLOR_CODE: Record<LogLevel, number> = {
  trace: 90,
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

/** Trace ring cap — env-tunable since trace is the high-volume stream. */
function resolveTraceBufferMax(): number {
  const raw = Number.parseInt(process.env.SNOWLUMA_TRACE_BUFFER ?? '', 10);
  return Number.isFinite(raw) && raw >= 100 ? raw : 5000;
}
const TRACE_BUFFER_MAX = resolveTraceBufferMax();

/**
 * Fixed-capacity circular buffer. O(1) push + eviction (no array `.shift()`),
 * so the high-throughput trace stream never pays an O(n) shift per overflow.
 */
class RingBuffer<T> {
  private readonly buf: (T | undefined)[];
  private start = 0;
  private count = 0;
  constructor(private readonly cap: number) {
    this.buf = new Array<T | undefined>(cap);
  }
  push(item: T): void {
    const end = (this.start + this.count) % this.cap;
    this.buf[end] = item;
    if (this.count < this.cap) this.count += 1;
    else this.start = (this.start + 1) % this.cap; // full → overwrite oldest
  }
  /** Most recent `n` items, oldest→newest. */
  recent(n: number): T[] {
    const take = Math.max(0, Math.min(Math.trunc(n), this.count));
    const out: T[] = new Array<T>(take);
    const first = this.start + (this.count - take);
    for (let i = 0; i < take; i += 1) out[i] = this.buf[(first + i) % this.cap]!;
    return out;
  }
  toArray(): T[] {
    return this.recent(this.count);
  }
  get size(): number {
    return this.count;
  }
}

const logRing = new RingBuffer<LogEntry>(MAX_LOG_ENTRIES);
const traceRing = new RingBuffer<LogEntry>(TRACE_BUFFER_MAX);
const logSubscribers = new Set<(entry: LogEntry) => void>();
let nextLogId = 1;

function resolveMinLevel(): LogLevel {
  const raw = (process.env.SNOWLUMA_LOG_LEVEL ?? 'info').toLowerCase();
  if (raw === 'trace' || raw === 'debug' || raw === 'info' || raw === 'success' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

// Mutable — seeded from SNOWLUMA_LOG_LEVEL at module load, but
// setLogLevel() lets WebUI / SDK callers flip it without a restart.
// Only governs console + ring buffer + subscribers; the file
// transport always sees debug-and-up regardless.
let currentLevel: LogLevel = resolveMinLevel();

function shouldLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[currentLevel];
}

export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'success', 'warn', 'error'];

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Change the console / subscriber level at runtime. Invalid input is
 * a no-op (returns false). File transport is unaffected — it always
 * sees every level so post-mortems remain useful.
 */
export function setLogLevel(level: string): boolean {
  const lower = String(level).toLowerCase();
  if (!LOG_LEVELS.includes(lower as LogLevel)) return false;
  currentLevel = lower as LogLevel;
  return true;
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

function render(level: LogLevel, options: LogOptions, args: unknown[], reqId?: number): string {
  const message = format(...args);
  const ts = currentTime();
  const label = LEVEL_LABEL[level].padEnd(5, ' ');
  const uinTag = options.uin !== undefined ? `[${options.uin}]` : '';
  const uinSlot = uinTag.padEnd(UIN_SLOT_WIDTH);
  const reqTag = reqId !== undefined ? `[req#${reqId}]` : '';

  if (!useColor()) {
    return `${ts} ${label} ${uinSlot} [${options.scope}] ${reqTag ? `${reqTag} ` : ''}${message}`;
  }

  const cTs = ansi(COLOR_DIM, ts);
  const cLabel = ansi(COLOR_CODE[level], label);
  // Pad first, then color only the visible tag so escape codes don't eat
  // into the alignment width.
  const cUin = uinTag
    ? ansi(COLOR_DIM, uinTag) + ' '.repeat(UIN_SLOT_WIDTH - uinTag.length)
    : ' '.repeat(UIN_SLOT_WIDTH);
  const cScope = ansi(COLOR_SCOPE, `[${options.scope}]`);
  const cReq = reqTag ? `${ansi(COLOR_DIM, reqTag)} ` : '';
  return `${cTs} ${cLabel} ${cUin} ${cScope} ${cReq}${message}`;
}

function emit(level: LogLevel, options: LogOptions, args: unknown[]): void {
  // Console / subscriber level filter. File output is debug-and-up always;
  // see log-file-transport.ts.
  const passesConsole = shouldLog(level);

  // `trace` never touches disk and is the high-volume full-chain stream. When
  // it won't reach the console/memory buffer either (level not dialed to
  // trace), bail BEFORE format/render AND before evaluating any lazy producer
  // — this is what keeps full-chain tracing ~free at the default level even
  // with hundreds of groups.
  if (level === 'trace' && !passesConsole) return;

  // Lazy trace form: `log.trace(() => ['…', deepRender(x)])`. The producer
  // (and its expensive deep render) only runs now that trace is confirmed live.
  let realArgs = args;
  if (level === 'trace' && args.length === 1 && typeof args[0] === 'function') {
    realArgs = (args[0] as () => unknown[])();
  }

  const reqId = currentRequestId();
  const message = format(...realArgs);
  const line = render(level, options, realArgs, reqId);
  const entry: LogEntry = {
    id: nextLogId++,
    time: new Date().toISOString(),
    level,
    scope: options.scope,
    ...(options.uin !== undefined ? { uin: options.uin } : {}),
    ...(reqId !== undefined ? { req: reqId } : {}),
    message,
    line,
  };

  if (passesConsole) {
    // Trace gets its own ring so its volume never evicts the normal log buffer.
    (level === 'trace' ? traceRing : logRing).push(entry);
    for (const subscriber of logSubscribers) subscriber(entry);
    const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
    // Strip ASCII control characters before writing to terminal to prevent
    // BEL (0x07) in user-provided strings (e.g. group member names) from
    // triggering Windows system beep sounds. Exempt TAB (0x09), LF (0x0A)
    // and ESC (0x1B) so multi-line records (stack traces) and ANSI color
    // sequences emitted by render() pass through intact.
    // eslint-disable-next-line no-control-regex
    stream.write(line.replace(/[\x00-\x08\x0B-\x1A\x1C-\x1F\x7F]/g, '') + '\n');
  }

  // File transport sees debug-and-up for post-mortem value; `trace` is
  // memory / WebUI only (omitted here to avoid huge on-disk volume). ANSI
  // stripping happens inside the transport. UIN routes the line to its
  // per-account sub-file in addition to the shared one.
  if (level !== 'trace') getFileTransport().write(line, options.uin);
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
  const n = Math.max(1, Math.trunc(limit));
  // Merge the normal + trace rings by id (ids are monotonic, so id order is
  // chronological). The trace ring is empty unless trace level is/was active,
  // so the common case is just the normal ring with no sort.
  const merged = traceRing.size > 0
    ? [...logRing.toArray(), ...traceRing.toArray()].sort((a, b) => a.id - b.id)
    : logRing.toArray();
  return merged.slice(-n);
}

export function subscribeLogs(callback: (entry: LogEntry) => void): () => void {
  logSubscribers.add(callback);
  return () => {
    logSubscribers.delete(callback);
  };
}

export interface Logger {
  /**
   * High-volume, memory-only diagnostic level (never written to disk). Pass a
   * lazy producer — `trace(() => ['msg %s', expensiveRender(x)])` — so the
   * arguments (and any costly rendering) are built only when trace is active.
   * A plain `trace('msg', x)` works too but evaluates its args eagerly.
   */
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  success: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /**
   * Derive a new logger that inherits this one's scope and carries
   * additional metadata. Currently `uin` is the only key with rendering
   * support (shown in the `[UIN]` slot and routed to a per-UIN file);
   * other keys are preserved on the options bag for forward compat.
   */
  child: (meta: { uin?: number;[k: string]: unknown }) => Logger;
}

function makeLogger(opts: LogOptions): Logger {
  return {
    trace: (...args: unknown[]) => emit('trace', opts, args),
    debug: (...args: unknown[]) => emit('debug', opts, args),
    info: (...args: unknown[]) => emit('info', opts, args),
    success: (...args: unknown[]) => emit('success', opts, args),
    warn: (...args: unknown[]) => emit('warn', opts, args),
    error: (...args: unknown[]) => emit('error', opts, args),
    child: (meta) => {
      const nextUin = typeof meta.uin === 'number' ? meta.uin : opts.uin;
      return makeLogger({
        scope: opts.scope,
        uin: nextUin,
        meta: { ...(opts.meta ?? {}), ...meta },
      });
    },
  };
}

export function createLogger(scope: string): Logger {
  return makeLogger({ scope });
}

// Request-correlation helpers live alongside the logger since `[req#N]`
// stamping is a logging concern. Re-exported here so callers import the
// whole logging surface from one place.
export { nextRequestId, runWithRequestId, currentRequestId } from './request-context';
