// Stream API file actions (#163) — NapCat-compatible chunked file transfer.
//
// upload_file_stream: a client (possibly on another machine) pushes a file to
// the bot in base64 chunks across repeated calls keyed by `stream_id`; the bot
// reassembles them into a local temp file and returns its path, which the
// client then feeds to a normal send action. This sidesteps the HTTP 2 MB body
// cap and the "client and bot share a filesystem" assumption of plain file://
// sends. Reassembly streams chunk-by-chunk to disk (no whole-file
// Buffer.concat) so an arbitrarily large upload won't OOM the bot.
//
// clean_stream_temp_file: wipe the stream temp dirs (upload + download), scoped
// so it never touches unrelated temp files.
//
// Hardening over the NapCat original (which has all of these holes): stream_id
// is allowlist-validated + every derived path is fenced inside the upload dir
// (no path traversal); total_chunks/chunk/stream/byte counts are all bounded
// (no single-request OOM or disk/fd exhaustion); chunk indices are claimed
// synchronously (no double-count race); state is namespaced per account.

import os from 'os';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { createLogger } from '@snowluma/common/logger';
import { defineAction, defineStreamAction, f } from '../action-kit';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import { okResponse, type ApiResponse } from '../types';
import { StreamStatus } from '../streaming';

const log = createLogger('OneBot.Stream');

export const STREAM_ROOT = path.join(os.tmpdir(), 'snowluma-stream');
export const STREAM_UPLOAD_DIR = path.join(STREAM_ROOT, 'upload');
export const STREAM_DOWNLOAD_DIR = path.join(STREAM_ROOT, 'download');

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;   // idle stream reaped after 10 min
const DEFAULT_RETENTION_MS = 5 * 60 * 1000; // reassembled file auto-deleted after 5 min

// Resource caps (DoS guards — the whole point of the disk-streaming design is
// blown if a single request can still OOM, and an unbounded server can be
// flooded with streams/chunks/bytes).
const MAX_CONCURRENT_STREAMS = 64;
const MAX_CHUNKS = 200_000;                       // also bounds the completion scan
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;         // one decoded chunk
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;  // 4 GiB cumulative per stream

// stream_id / account key allowlist: filename-safe, no separators, no dots
// (so no `.`/`..` traversal token can ever reach a path segment).
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

class StreamError extends Error {}

function validateStreamId(id: string): void {
  if (!SAFE_ID_RE.test(id)) throw new StreamError('invalid stream_id (allowed: 1-128 chars of A-Z a-z 0-9 _ -)');
}

/** Account namespace for the in-memory map + on-disk dirs. Empty (tests / no
 *  login) → flat, un-namespaced. Sanitised so it can't widen the path either. */
function accountKey(ctx?: ApiActionContext): string {
  let raw = '';
  try { raw = String(ctx?.getLoginInfo?.().userId ?? ''); } catch { raw = ''; }
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

/** Belt-and-braces: assert a derived path stays inside the upload dir even if
 *  the allowlist above is ever weakened. */
function assertWithin(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new StreamError('resolved stream path escapes the upload directory');
  }
}

// ─────────────────────────── upload state ───────────────────────────

interface UploadState {
  /** Client-facing stream_id (echoed in frames). */
  id: string;
  /** Internal map key — `<account>:<id>` or just `<id>` when un-namespaced. */
  key: string;
  filename: string;
  totalChunks: number;
  /** Indices CLAIMED (sync, before the write await) — drives dedup + byte
   *  accounting so two concurrent calls for one index can't double-count. */
  claimed: Set<number>;
  /** Indices actually FLUSHED to disk (added after the write resolves) — drives
   *  completion + the reported count, so completion can't fire while a chunk
   *  file is still being written (which would read a truncated part). Neither
   *  set is pre-allocated to total_chunks (that would defeat the no-OOM goal). */
  written: Set<number>;
  bytesWritten: number;
  fileSize?: number;
  expectedSha256?: string;
  tempDir: string;
  finalPath: string;
  fileRetention: number;
  timeoutId: NodeJS.Timeout;
}

/** Process-wide. Key is account-namespaced so two accounts (same process) can't
 *  collide on a shared/non-UUID stream_id. */
const uploads = new Map<string, UploadState>();

function reapTimer(key: string): NodeJS.Timeout {
  const t = setTimeout(() => { cleanupUpload(key, true); }, UPLOAD_TIMEOUT_MS);
  if (typeof t.unref === 'function') t.unref(); // don't pin the event loop on a stalled upload
  return t;
}

function cleanupUpload(key: string, deleteFinal: boolean): void {
  const state = uploads.get(key);
  if (!state) return;
  clearTimeout(state.timeoutId);
  try { fs.rmSync(state.tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  if (deleteFinal) {
    try { fs.rmSync(state.finalPath, { force: true }); } catch { /* best effort */ }
  }
  uploads.delete(key);
}

function safeFilename(name: string | undefined, id: string): string {
  const base = (name ?? '')
    .replace(/[/\\]/g, '_')   // no directory separators
    .replace(/\.\.+/g, '_')   // no `..` traversal tokens
    .replace(/^\.+/, '')      // no leading dots
    .trim();
  return base || `upload_${id}`;
}

function createUpload(p: UploadParams, account: string): UploadState {
  if (!p.total_chunks || p.total_chunks <= 0) throw new StreamError('total_chunks required for new stream');
  if (p.total_chunks > MAX_CHUNKS) throw new StreamError(`total_chunks exceeds limit (${MAX_CHUNKS})`);
  if (p.file_size !== undefined && p.file_size > MAX_UPLOAD_BYTES) throw new StreamError(`file_size exceeds limit (${MAX_UPLOAD_BYTES} bytes)`);
  if (uploads.size >= MAX_CONCURRENT_STREAMS) throw new StreamError(`too many concurrent upload streams (${MAX_CONCURRENT_STREAMS})`);

  const filename = safeFilename(p.filename, p.stream_id);
  const dirRoot = account ? path.join(STREAM_UPLOAD_DIR, account) : STREAM_UPLOAD_DIR;
  const tempDir = path.join(dirRoot, p.stream_id);
  const finalPath = path.join(dirRoot, `${p.stream_id}__${filename}`);
  assertWithin(STREAM_UPLOAD_DIR, tempDir);
  assertWithin(STREAM_UPLOAD_DIR, finalPath);
  fs.mkdirSync(tempDir, { recursive: true });

  const key = account ? `${account}:${p.stream_id}` : p.stream_id;
  const state: UploadState = {
    id: p.stream_id,
    key,
    filename,
    totalChunks: p.total_chunks,
    claimed: new Set(),
    written: new Set(),
    bytesWritten: 0,
    fileSize: p.file_size,
    expectedSha256: p.expected_sha256,
    tempDir,
    finalPath,
    fileRetention: p.file_retention,
    timeoutId: reapTimer(key),
  };
  uploads.set(key, state);
  return state;
}

function statusFrame(state: UploadState, status: string): ApiResponse {
  return okResponse({
    type: StreamStatus.Stream,
    stream_id: state.id,
    status,
    received_chunks: state.written.size,
    total_chunks: state.totalChunks,
  });
}

function writeChunkToStream(stream: fs.WriteStream, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

async function completeUpload(state: UploadState): Promise<ApiResponse> {
  if (state.written.size !== state.totalChunks) {
    const missing: number[] = [];
    for (let i = 0; i < state.totalChunks && missing.length < 16; i++) {
      if (!state.written.has(i)) missing.push(i);
    }
    const more = state.totalChunks - state.written.size > missing.length ? '…' : '';
    throw new StreamError(`incomplete stream: missing ${state.totalChunks - state.written.size} chunk(s) [${missing.join(',')}${more}]`);
  }

  // Stream each chunk file into the final file in order, hashing as we go — one
  // chunk in memory at a time, never the whole payload.
  const hash = createHash('sha256');
  const out = fs.createWriteStream(state.finalPath);
  try {
    for (let i = 0; i < state.totalChunks; i++) {
      const buf = await fs.promises.readFile(path.join(state.tempDir, `${i}.chunk`));
      hash.update(buf);
      await writeChunkToStream(out, buf);
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    try { fs.rmSync(state.finalPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }

  const sha256 = hash.digest('hex');
  if (state.expectedSha256 && sha256 !== state.expectedSha256) {
    try { fs.rmSync(state.finalPath, { force: true }); } catch { /* best effort */ }
    throw new StreamError(`sha256 mismatch (expected ${state.expectedSha256}, got ${sha256})`);
  }

  const finalPath = state.finalPath;
  const fileSize = fs.statSync(finalPath).size;
  const received = state.written.size;
  const total = state.totalChunks;
  const retention = state.fileRetention;

  // Drop chunk parts + in-memory state but KEEP the reassembled file.
  cleanupUpload(state.key, false);
  if (retention > 0) {
    const t = setTimeout(() => {
      fs.rm(finalPath, { force: true }, (err) => {
        if (err) log.warn('failed to delete retained stream file %s: %s', finalPath, err.message);
      });
    }, retention);
    if (typeof t.unref === 'function') t.unref();
  }

  return okResponse({
    type: StreamStatus.Response,
    stream_id: state.id,
    status: 'file_complete',
    received_chunks: received,
    total_chunks: total,
    file_path: finalPath,
    file_size: fileSize,
    sha256,
  });
}

async function handleUpload(p: UploadParams, account = ''): Promise<ApiResponse> {
  validateStreamId(p.stream_id);
  const key = account ? `${account}:${p.stream_id}` : p.stream_id;

  if (p.reset) {
    cleanupUpload(key, true);
    // NapCat surfaces reset as an error frame; mirror it for client parity.
    throw new StreamError('Stream reset completed');
  }

  if (p.verify_only) {
    const state = uploads.get(key);
    if (!state) throw new StreamError('stream not found');
    return statusFrame(state, 'file_created');
  }

  const state = uploads.get(key) ?? createUpload(p, account);
  // Metadata may arrive on the creating call or any later one (e.g. the client
  // only knows the whole-file sha256 when it sends `is_complete`).
  if (p.expected_sha256 !== undefined) state.expectedSha256 = p.expected_sha256;
  if (p.file_size !== undefined) state.fileSize = p.file_size;

  if (p.chunk_data !== undefined && p.chunk_index !== undefined) {
    const index = p.chunk_index;
    if (index < 0 || index >= state.totalChunks) throw new StreamError(`invalid chunk index: ${index}`);
    if (state.claimed.has(index)) return statusFrame(state, 'chunk_received'); // duplicate / in-flight — idempotent

    const buf = Buffer.from(p.chunk_data, 'base64');
    if (buf.length > MAX_CHUNK_BYTES) throw new StreamError(`chunk exceeds size limit (${MAX_CHUNK_BYTES} bytes)`);
    if (state.bytesWritten + buf.length > MAX_UPLOAD_BYTES) throw new StreamError(`stream exceeds total size limit (${MAX_UPLOAD_BYTES} bytes)`);

    // Claim the index synchronously (before the write await) so two concurrent
    // calls for the same index can't both pass the dedup check or double-count
    // bytes. `written` is only set AFTER the bytes hit disk, so completion can
    // never fire while this chunk file is still being written.
    state.claimed.add(index);
    state.bytesWritten += buf.length;
    try {
      await fs.promises.writeFile(path.join(state.tempDir, `${index}.chunk`), buf);
    } catch (err) {
      state.claimed.delete(index);
      state.bytesWritten -= buf.length;
      throw err;
    }
    state.written.add(index);
    clearTimeout(state.timeoutId);
    state.timeoutId = reapTimer(state.key);
    return statusFrame(state, 'chunk_received');
  }

  if (p.is_complete || state.written.size === state.totalChunks) {
    return completeUpload(state);
  }

  return statusFrame(state, 'file_created');
}

// ─────────────────────────── action definitions ───────────────────────────

const uploadParams = {
  stream_id: f.string({ allowEmpty: false }).describe('流 ID(客户端生成的 UUID,限 [A-Za-z0-9_-])'),
  chunk_data: f.string().optional().describe('分块数据(Base64)'),
  chunk_index: f.int({ min: 0 }).optional().describe('分块索引(从 0 开始)'),
  total_chunks: f.int({ min: 1 }).optional().describe('总分块数(新流必填)'),
  file_size: f.int({ min: 0 }).optional().describe('文件总大小(字节)'),
  expected_sha256: f.string().optional().describe('期望的整文件 SHA256(校验)'),
  is_complete: f.bool().optional().describe('是否为最后一个分块/触发合并'),
  filename: f.string().optional().describe('文件名'),
  reset: f.bool().optional().describe('重置并丢弃该流'),
  verify_only: f.bool().optional().describe('仅查询当前流状态'),
  file_retention: f.int({ min: 0 }).default(DEFAULT_RETENTION_MS).describe('合并文件保留毫秒(0=不回收)'),
};

type UploadParams = {
  stream_id: string;
  chunk_data: string | undefined;
  chunk_index: number | undefined;
  total_chunks: number | undefined;
  file_size: number | undefined;
  expected_sha256: string | undefined;
  is_complete: boolean | undefined;
  filename: string | undefined;
  reset: boolean | undefined;
  verify_only: boolean | undefined;
  file_retention: number;
};

const uploadFileStream = defineStreamAction({
  name: 'upload_file_stream',
  summary: '以流式分块方式上传文件到机器人本地(返回可用于发送的本地路径)',
  returns: '流式帧:分块确认 type=stream、完成 type=response(含 file_path/file_size/sha256)',
  params: uploadParams,
  run: (p, ctx) => handleUpload(p, accountKey(ctx)),
});

function cleanDir(dir: string): number {
  let removed = 0;
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return 0; } // dir absent → nothing to clean
  for (const name of entries) {
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); removed++; } catch (err) {
      log.warn('failed to remove stream temp %s: %s', path.join(dir, name), err instanceof Error ? err.message : String(err));
    }
  }
  return removed;
}

const cleanStreamTempFile = defineAction({
  name: 'clean_stream_temp_file',
  summary: '清理流式传输临时文件(仅清理 stream 上传/下载目录)',
  returns: '{ message, removed }',
  params: {},
  run: () => {
    const removed = cleanDir(STREAM_UPLOAD_DIR) + cleanDir(STREAM_DOWNLOAD_DIR);
    // Active uploads' chunk dirs may have been wiped — drop their state too.
    for (const k of [...uploads.keys()]) cleanupUpload(k, false);
    return okResponse({ message: 'success', removed });
  },
});

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  uploadFileStream.register(h, ctx);
  cleanStreamTempFile.register(h, ctx);
}

// Exposed for tests.
export const __test = { uploads, handleUpload, cleanDir, validateStreamId, STREAM_UPLOAD_DIR, MAX_CONCURRENT_STREAMS, MAX_CHUNKS };
