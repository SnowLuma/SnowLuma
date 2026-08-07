// Stage any upload source onto a local disk path so the uploader can stream it
// (#stream-upload). Unifies the three source kinds into one "here is a file on
// disk + its size + a cleanup" contract, so the streaming hash pass and the
// FileChunkSource PUT never have to care where the bytes came from:
//
//   file:// / raw path → hardlink into our own stage dir (O(1); the extra inode
//                        link pins the bytes so a caller-side retention/unlink
//                        — e.g. upload_file_stream's timer — can't delete the
//                        data mid-send). Copy fallback on any link() failure.
//   http(s)://         → stream the download to a .part file, fsync, atomic
//                        rename (shares the exact transport of loadBinarySource
//                        via downloadHttp — same UA/redirect/timeout/retry/caps).
//   base64:// / data:  → enforce maxBytes on the DECODED length, then decode to
//                        a .part file and rename.
//
// Crash safety: staged temps are written `.part` → fsync → rename → fsync(dir),
// so a partial file is never consumed; a background TTL reaper reaps temps left
// by a crash, skipping any path currently in use (the `active` set), so it can
// never delete an in-flight upload.

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '@snowluma/common/logger';
import {
  downloadHttp,
  inlineBase64Payload,
  resolveLocalFilePath,
  type DownloadSink,
} from './utils';

const log = createLogger('Highway.Stage');

export const STAGE_DIR = path.join(os.tmpdir(), 'media-stage');
// Must comfortably exceed the slowest plausible single upload (a 1.5 GiB PUT at
// a few MB/s is ~5-10 min). Only unregistered (crash-orphaned) temps are reaped.
const STAGE_TTL_MS = 30 * 60 * 1000;
const REAPER_INTERVAL_MS = 5 * 60 * 1000;

/** Absolute paths currently in use (being written, or a live staged file). The
 *  reaper never touches these — an in-flight upload's file is read-only so its
 *  mtime won't advance, and an age-only sweep would otherwise delete it. */
const active = new Set<string>();

export interface StagedSource {
  /** Local disk path the uploader reads from. */
  filePath: string;
  fileSize: number;
  /** Caller-facing name (URL basename / original local basename); '' for base64. */
  fileName: string;
  /** Remove the staged temp (our hardlink/copy/downloaded file). Idempotent,
   *  best-effort; never throws. Never touches the caller's original file. */
  cleanup(): Promise<void>;
}

let reaperTimer: NodeJS.Timeout | null = null;
function ensureReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => { void sweepStagedUploads(); }, REAPER_INTERVAL_MS);
  reaperTimer.unref(); // never pin the event loop
  void sweepStagedUploads(); // startup sweep of crash orphans
}

/** Reap staged temps older than the TTL, skipping any path currently in use.
 *  Best-effort; never throws. Exposed for an explicit startup/interval hook. */
export async function sweepStagedUploads(now: number = Date.now()): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await fsp.readdir(STAGE_DIR);
  } catch {
    return 0; // dir not created yet
  }
  await Promise.all(names.map(async (n) => {
    const p = path.join(STAGE_DIR, n);
    if (active.has(p)) return; // in-flight — never reap
    try {
      const s = await fsp.stat(p);
      if (now - s.mtimeMs > STAGE_TTL_MS) {
        await fsp.rm(p, { force: true });
        removed += 1;
      }
    } catch { /* vanished / racing cleanup */ }
  }));
  if (removed > 0) log.debug('reaped %d stale staged upload temp(s)', removed);
  return removed;
}

function tempPaths(ext: string): { partPath: string; finalPath: string } {
  const id = randomUUID();
  const base = path.join(STAGE_DIR, `stage-${id}${ext}`);
  return { partPath: `${base}.part`, finalPath: base };
}

/** fsync the file's directory entry so the rename survives a crash (POSIX). */
async function fsyncDir(): Promise<void> {
  try {
    const dh = await fsp.open(STAGE_DIR, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* some platforms reject directory fsync — best effort */ }
}

async function finalizeRename(partPath: string, finalPath: string): Promise<void> {
  await fsp.rename(partPath, finalPath);
  await fsyncDir();
}

function registerStaged(filePath: string, fileSize: number, fileName: string): StagedSource {
  active.add(filePath);
  let done = false;
  return {
    filePath,
    fileSize,
    fileName,
    async cleanup() {
      if (done) return;
      done = true;
      active.delete(filePath);
      await fsp.unlink(filePath).catch(() => { /* best-effort */ });
    },
  };
}

/** Disk sink for `downloadHttp`: streams chunks to a FileHandle, fsyncs on
 *  success, and closes-before-unlink on failure. Backpressure comes from
 *  awaiting each `fh.write`. */
function fileSink(partPath: string): DownloadSink<void> {
  let opened: Promise<import('fs').promises.FileHandle> | null = null;
  const open = () => (opened ??= fsp.open(partPath, 'w'));
  return {
    async write(chunk) { const fh = await open(); await fh.write(chunk); },
    async done() {
      const fh = await open(); // create even for an empty body
      await fh.sync();
      await fh.close();
    },
    async discard() {
      if (opened) { try { const fh = await opened; await fh.close(); } catch { /* already closed */ } }
      await fsp.unlink(partPath).catch(() => { /* best-effort */ });
    },
  };
}

/** base64 decoded byte length without allocating the buffer. */
function base64DecodedLength(b64: string): number {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - pad;
}

/**
 * Stage `source` onto a local disk path. `maxBytes` bounds the size (rejected
 * before any large allocation for base64, before reading for local files, and
 * incrementally for http). The returned `cleanup()` MUST be called when the
 * upload is done (or fails) to remove the staged temp.
 */
export async function stageSourceToDisk(source: string, maxBytes: number): Promise<StagedSource> {
  if (!source) throw new Error('stage source is empty');
  ensureReaper();
  await fsp.mkdir(STAGE_DIR, { recursive: true });

  // ── inline Base64 (`base64://` or RFC 2397 `data:`) ────────────────────
  const b64 = inlineBase64Payload(source);
  if (b64 !== null) {
    const decodedLen = base64DecodedLength(b64);
    if (decodedLen > maxBytes) {
      throw new Error(`stage source too large: ${decodedLen} > ${maxBytes}`);
    }
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length > maxBytes) {
      throw new Error(`stage source too large: ${bytes.length} > ${maxBytes}`);
    }
    const { partPath, finalPath } = tempPaths('.bin');
    active.add(partPath);
    try {
      const fh = await fsp.open(partPath, 'w');
      try { await fh.write(bytes); await fh.sync(); } finally { await fh.close(); }
      await finalizeRename(partPath, finalPath);
    } catch (e) {
      await fsp.unlink(partPath).catch(() => { /* best-effort */ });
      throw e;
    } finally {
      active.delete(partPath);
    }
    log.debug('staged inline base64 source (%d bytes)', bytes.length);
    return registerStaged(finalPath, bytes.length, '');
  }

  // ── http(s):// ─────────────────────────────────────────────────────────
  if (/^https?:\/\//i.test(source)) {
    const { partPath, finalPath } = tempPaths('.bin');
    active.add(partPath);
    let fileName = '';
    try {
      const r = await downloadHttp<void>(source, 'stage', maxBytes, () => fileSink(partPath));
      fileName = r.fileName;
      await finalizeRename(partPath, finalPath);
    } catch (e) {
      await fsp.unlink(partPath).catch(() => { /* best-effort */ });
      throw e;
    } finally {
      active.delete(partPath);
    }
    const { size } = await fsp.stat(finalPath);
    log.debug('staged http source %s (%d bytes)', fileName || '(unnamed)', size);
    return registerStaged(finalPath, size, fileName);
  }

  // ── local path / file:// ───────────────────────────────────────────────
  const local = resolveLocalFilePath(source);
  if (!local) throw new Error('stage source is not a local file');
  const real = await fsp.realpath(local); // resolve symlinks — hardlink the target, not the link
  const st = await fsp.stat(real);
  if (!st.isFile()) throw new Error(`stage source is not a regular file: ${local}`);
  if (st.size > maxBytes) throw new Error(`stage source too large: ${st.size} > ${maxBytes}`);
  const fileName = path.basename(local); // caller-facing name (before symlink resolution)
  const { partPath, finalPath } = tempPaths(path.extname(local) || '.bin');

  // Reserve finalPath in `active` BEFORE it exists on disk. A hardlink inherits
  // the source's (often old) mtime, so — unlike the fresh-mtime http/base64/copy
  // temps whose TTL saves them during the pre-register gap — only the active-set
  // can keep the age reaper from deleting this live staged file in the window
  // between link and registerStaged.
  active.add(finalPath);
  let staged: 'link' | 'copy';
  try {
    try {
      await fsp.link(real, finalPath); // O(1) hardlink; pins the inode against caller-side unlink
      staged = 'link';
    } catch {
      // Any link() failure (cross-fs EXDEV, hardlink protection, permissions,
      // link-count/platform limits) — fall back to a streamed copy of the
      // readable source (disk-to-disk, never buffered in RAM).
      active.add(partPath);
      try {
        await fsp.copyFile(real, partPath);
        const fh = await fsp.open(partPath, 'r+'); // fsync copied data before rename
        try { await fh.sync(); } finally { await fh.close(); }
        await finalizeRename(partPath, finalPath);
        staged = 'copy';
      } finally {
        active.delete(partPath);
      }
    }
  } catch (e) {
    active.delete(finalPath);
    await fsp.unlink(finalPath).catch(() => { /* best-effort */ });
    await fsp.unlink(partPath).catch(() => { /* best-effort */ });
    throw e;
  }
  log.debug('staged local source %s via %s (%d bytes)', fileName, staged, st.size);
  return registerStaged(finalPath, st.size, fileName);
}
