import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, type Logger } from '@snowluma/common/logger';

export const STAGE_FILE_NAME = 's7.log';
export const MIRROR_LIMIT_BYTES = 1024 * 1024;

const VERSION_HEADER = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function isVersionHeader(line: string): boolean {
  return VERSION_HEADER.test(line);
}

export function lineSeverity(line: string): 'info' | 'error' {
  const parts = line.trim().split(/\s+/);
  return parts.length >= 4 && parts[3] === '1' ? 'error' : 'info';
}

export function publicLine(version: string, raw: string): string {
  return `${version} ${raw.trim()}`;
}

function byteSize(lines: readonly string[]): number {
  if (lines.length === 0) return 0;
  return Buffer.byteLength(`${lines.join('\n')}\n`, 'utf8');
}

export function trimMirror(text: string, limit = MIRROR_LIMIT_BYTES): string {
  const lines = text.split('\n').filter((line) => line.length > 0);
  const size = () => byteSize(lines);
  while (lines.length > 0 && size() > limit) {
    const body = lines.findIndex((line) => !isVersionHeader(line));
    if (body >= 0) {
      lines.splice(body, 1);
      continue;
    }
    if (lines.length <= 1) break;
    lines.shift();
  }
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
}

export function appendEvents(
  mirror: string,
  version: string,
  events: readonly string[],
  limit = MIRROR_LIMIT_BYTES,
): string {
  const fresh = events.map((line) => line.trim()).filter((line) => line.length > 0);
  if (fresh.length === 0) return mirror;
  const header = `v${version}`;
  const lines = mirror.split('\n').filter((line) => line.length > 0);
  let lastHeader = '';
  for (const line of lines) {
    if (isVersionHeader(line)) lastHeader = line;
  }
  const next = [...lines];
  if (lastHeader !== header) next.push(header);
  next.push(...fresh);
  return trimMirror(`${next.join('\n')}\n`, limit);
}

export function tempStagePath(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const base = env.TMP || env.TEMP || os.tmpdir();
    return path.join(base, STAGE_FILE_NAME);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return `/tmp/sl-${uid}/${STAGE_FILE_NAME}`;
}

export function readAppVersion(moduleUrl: string | URL = import.meta.url): string {
  if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__) return __APP_VERSION__;
  try {
    const raw = readFileSync(new URL('../package.json', moduleUrl), 'utf8');
    const version = JSON.parse(raw).version;
    if (typeof version === 'string' && version.trim()) return version.trim();
  } catch {
    // Built layouts that do not sit next to a package manifest keep the fallback.
  }
  return '0.0.0';
}

export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return 'ERR';
}

export interface StageSyncOptions {
  version: string;
  dataDir: string;
  tempPath: string;
  log?: Logger;
  intervalMs?: number;
}

interface IngestResult {
  mirror: string;
  offset: number;
  lines: string[];
  missing: boolean;
  errorCode?: string;
}

export function ingestTemp(args: {
  tempText: string;
  offset: number;
  mirror: string;
  version: string;
  missing?: boolean;
  errorCode?: string;
}): IngestResult {
  if (args.missing) {
    return { mirror: args.mirror, offset: args.offset, lines: [], missing: true };
  }
  if (args.errorCode) {
    return {
      mirror: args.mirror,
      offset: args.offset,
      lines: [],
      missing: false,
      errorCode: args.errorCode,
    };
  }
  const start = args.offset > args.tempText.length ? 0 : args.offset;
  const chunk = args.tempText.slice(start);
  const newline = chunk.lastIndexOf('\n');
  if (newline < 0) {
    return { mirror: args.mirror, offset: start, lines: [], missing: false };
  }
  const complete = chunk.slice(0, newline + 1);
  const lines = complete.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return {
    mirror: appendEvents(args.mirror, args.version, lines),
    offset: start + newline + 1,
    lines,
    missing: false,
  };
}

function readOffset(file: string): number {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function readTemp(file: string): { text: string; missing: boolean; errorCode?: string } {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const info = fstatSync(fd);
    const size = info.size;
    if (size > 8 * 1024 * 1024) {
      return { text: '', missing: false, errorCode: 'E2BIG' };
    }
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const n = readSync(fd, buf, got, size - got, got);
      if (n <= 0) break;
      got += n;
    }
    return { text: buf.subarray(0, got).toString('utf8'), missing: false };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return { text: '', missing: true };
    return { text: '', missing: false, errorCode: code };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function startNativeStageSync(options: StageSyncOptions): { stop: () => void } {
  const log = options.log ?? createLogger('native');
  const mirrorPath = path.join(options.dataDir, STAGE_FILE_NAME);
  const offsetPath = path.join(options.dataDir, 's7.off');
  let offset = readOffset(offsetPath);
  let failed = false;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    let tempSize = 0;
    try {
      tempSize = statSync(options.tempPath).size;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return;
      if (!failed) {
        failed = true;
        log.error('sync failed %s', code);
      }
      return;
    }
    if (tempSize < offset) offset = 0;
    const temp = readTemp(options.tempPath);
    if (temp.missing) return;
    if (temp.errorCode) {
      if (!failed) {
        failed = true;
        log.error('sync failed %s', temp.errorCode);
      }
      return;
    }
    let mirror = '';
    try {
      mirror = readFileSync(mirrorPath, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        if (!failed) {
          failed = true;
          log.error('sync failed %s', errorCode(error));
        }
        return;
      }
    }
    const ingested = ingestTemp({
      tempText: temp.text,
      offset,
      mirror,
      version: options.version,
    });
    if (ingested.lines.length === 0 && ingested.offset === offset) {
      failed = false;
      return;
    }
    try {
      mkdirSync(options.dataDir, { recursive: true });
      writeFileSync(mirrorPath, ingested.mirror);
      writeFileSync(offsetPath, `${ingested.offset}\n`);
      offset = ingested.offset;
      failed = false;
    } catch (error) {
      if (!failed) {
        failed = true;
        log.error('sync failed %s', errorCode(error));
      }
      return;
    }
    for (const line of ingested.lines) {
      const text = publicLine(options.version, line);
      if (lineSeverity(line) === 'error') log.error('%s', text);
      else log.info('%s', text);
    }
  };

  tick();
  const timer = setInterval(tick, options.intervalMs ?? 500);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
