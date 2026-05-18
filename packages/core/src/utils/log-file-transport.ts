// File transport for the SnowLuma logger.
//
// Writes plain text (ANSI stripped) to:
//   <SNOWLUMA_LOG_DIR>/snowluma-YYYY-MM-DD.log         (shared, all UINs)
//   <SNOWLUMA_LOG_DIR>/<uin>/snowluma-YYYY-MM-DD.log   (per-account)
//
// Both pathways use the same daily rotation + per-file size cap. When the
// cap is hit the in-flight file is closed and writes continue in
//   snowluma-YYYY-MM-DD.1.log, .2.log, ...
// at the same date. Files older than the retain window are unlinked on
// startup and on each day rollover.
//
// Disabled via SNOWLUMA_LOG_FILE=0. Per-UIN sub-files are additionally
// gated by SNOWLUMA_LOG_PER_UIN=0 (still keeps the shared file). Any I/O
// failure during init or write degrades silently to console-only — we
// deliberately do NOT use the logger from inside this module to avoid
// recursion.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR = 'logs';
const DEFAULT_MAX_MB = 50;
const DEFAULT_RETAIN_DAYS = 7;
const FILE_PREFIX = 'snowluma-';
const FILE_SUFFIX = '.log';
const FILE_RE = /^snowluma-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
// Preserve TAB (0x09), LF (0x0A) and ESC (0x1B) — TAB / LF for legit
// multi-line records (stack traces), ESC is stripped through ANSI_RE.
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0B-\x1A\x1C-\x1F\x7F]/g;

function parsePositiveInt(v: string | undefined, dflt: number): number {
  if (!v) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function todayString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateOf(s: string): Date {
  const [y, m, d] = s.split('-').map((v) => Number.parseInt(v, 10));
  return new Date(y!, m! - 1, d!);
}

function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, '').replace(CTRL_RE, '');
}

interface OpenFile {
  stream: fs.WriteStream;
  bytes: number;
  date: string;
  splitIndex: number;
  path: string;
}

/**
 * Owns one output directory: keeps at most one open WriteStream, handles
 * daily rollover, per-file size cap, and retention cleanup. The shared
 * top-level dir uses one of these; each per-UIN sub-dir gets its own.
 */
class FileWriter {
  private disabled = false;
  private file: OpenFile | null = null;

  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
    private readonly retainDays: number,
  ) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.disabled = true;
      // eslint-disable-next-line no-console
      console.error(
        `[logger] failed to create log dir ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.cleanup();
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  get currentPath(): string | null {
    return this.file?.path ?? null;
  }

  write(data: string, bytes: number): void {
    if (this.disabled) return;
    const today = todayString();
    this.ensureForToday(today);
    if (!this.file) return;

    if (this.file.bytes + bytes > this.maxBytes && this.file.bytes > 0) {
      this.rotateBySize();
      if (!this.file) return;
    }

    this.file.stream.write(data);
    this.file.bytes += bytes;
  }

  close(): Promise<void> {
    const f = this.file;
    this.file = null;
    if (!f) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        f.stream.end(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private ensureForToday(today: string): void {
    if (this.file && this.file.date === today) return;

    if (this.file) {
      try {
        this.file.stream.end();
      } catch {
        /* ignore */
      }
      this.file = null;
      this.cleanup();
    }

    // Resume from the highest existing split index for today (so two
    // process starts on the same day share files / don't clobber).
    let idx = 0;
    while (fs.existsSync(this.pathFor(today, idx + 1))) idx++;
    this.file = this.openFile(today, idx);
  }

  private rotateBySize(): void {
    if (!this.file) return;
    const date = this.file.date;
    try {
      this.file.stream.end();
    } catch {
      /* ignore */
    }
    let next = this.file.splitIndex + 1;
    while (fs.existsSync(this.pathFor(date, next))) next++;
    this.file = this.openFile(date, next);
  }

  private openFile(date: string, splitIndex: number): OpenFile | null {
    const p = this.pathFor(date, splitIndex);
    try {
      let bytes = 0;
      try {
        bytes = fs.statSync(p).size;
      } catch {
        /* file doesn't exist yet */
      }
      const stream = fs.createWriteStream(p, { flags: 'a' });
      stream.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error(`[logger] file write error on ${p}: ${err.message}`);
      });
      return { stream, bytes, date, splitIndex, path: p };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[logger] failed to open log file ${p}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private pathFor(date: string, splitIndex: number): string {
    const tail = splitIndex > 0 ? `.${splitIndex}` : '';
    return path.join(this.dir, `${FILE_PREFIX}${date}${tail}${FILE_SUFFIX}`);
  }

  private cleanup(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const retainMs = this.retainDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retainMs;
    for (const name of entries) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      const dateStr = m[1]!;
      if (dateOf(dateStr).getTime() < cutoff) {
        try {
          fs.unlinkSync(path.join(this.dir, name));
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export class FileTransport {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly retainDays: number;
  private readonly enabled: boolean;
  private readonly perUinEnabled: boolean;
  private shared: FileWriter | null = null;
  private perUin = new Map<number, FileWriter>();

  constructor() {
    this.dir = process.env.SNOWLUMA_LOG_DIR || DEFAULT_DIR;
    this.maxBytes =
      parsePositiveInt(process.env.SNOWLUMA_LOG_MAX_MB, DEFAULT_MAX_MB) * 1024 * 1024;
    this.retainDays = parsePositiveInt(
      process.env.SNOWLUMA_LOG_RETAIN_DAYS,
      DEFAULT_RETAIN_DAYS,
    );
    this.enabled = process.env.SNOWLUMA_LOG_FILE !== '0';
    this.perUinEnabled = process.env.SNOWLUMA_LOG_PER_UIN !== '0';

    if (this.enabled) {
      const w = new FileWriter(this.dir, this.maxBytes, this.retainDays);
      this.shared = w.isDisabled ? null : w;
    }
  }

  /** True when no file output will happen (env disable or init failure). */
  get isDisabled(): boolean {
    return !this.shared;
  }

  /** Current shared-file path (or null if disabled / not yet opened). */
  get currentPath(): string | null {
    return this.shared?.currentPath ?? null;
  }

  /** Path of the per-UIN file for the given UIN, if open. */
  perUinPath(uin: number): string | null {
    return this.perUin.get(uin)?.currentPath ?? null;
  }

  write(line: string, uin?: number): void {
    if (!this.shared) return;
    const data = stripAnsi(line) + '\n';
    const bytes = Buffer.byteLength(data, 'utf8');

    this.shared.write(data, bytes);

    if (uin !== undefined && this.perUinEnabled) {
      let w = this.perUin.get(uin);
      if (!w) {
        w = new FileWriter(path.join(this.dir, String(uin)), this.maxBytes, this.retainDays);
        if (w.isDisabled) return;
        this.perUin.set(uin, w);
      }
      w.write(data, bytes);
    }
  }

  async close(): Promise<void> {
    const closes: Promise<void>[] = [];
    if (this.shared) closes.push(this.shared.close());
    for (const w of this.perUin.values()) closes.push(w.close());
    this.shared = null;
    this.perUin.clear();
    await Promise.all(closes);
  }
}

let singleton: FileTransport | null = null;

export function getFileTransport(): FileTransport {
  if (!singleton) singleton = new FileTransport();
  return singleton;
}

/** Reset state between tests. Closes all active file handles. */
export async function _resetFileTransportForTesting(): Promise<void> {
  if (singleton) await singleton.close();
  singleton = null;
}
