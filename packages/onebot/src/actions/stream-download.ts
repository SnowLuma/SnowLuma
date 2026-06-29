// Stream API download actions (#163) — NapCat-compatible server-push streaming.
//
// download_file_stream / _image_stream / _record_stream answer one request with
// many frames: a `file_info` header, then N `file_chunk` frames (base64), then a
// terminal `file_complete`. The bytes come from one of three sources, resolved
// from the `file` arg:
//   • a local file UNDER the stream temp root (e.g. something a client just
//     pushed via upload_file_stream) — streamed straight off disk;
//   • an http(s) URL — fetched and re-streamed;
//   • a cached image/voice id from a received message — resolved to its QQ CDN
//     URL, then fetched.
// test_download_stream pushes 10 canned frames so a client can verify the
// streaming transport without touching QQ.
//
// Hardening beyond the NapCat original (which streams ANY local path and
// fetches ANY URL): local reads are fenced inside the stream temp root (no
// arbitrary-file read via a leaked token), and URL fetches are SSRF-guarded
// (no private/loopback/link-local targets) + size-capped.

import fs from 'fs';
import path from 'path';
import net from 'net';
import dns from 'dns/promises';
import { resolveLocalFilePath } from '@snowluma/protocol/highway/utils';
import { defineStreamAction, f } from '../action-kit';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import { okResponse, type ApiResponse, type JsonObject, type JsonValue } from '../types';
import { type StreamSink, StreamStatus } from '../streaming';
import { STREAM_ROOT } from './stream-file';

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_REQUEST_BYTES = 16 * 1024 * 1024;     // cap the client-requested chunk size
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;    // 4 GiB total
const FETCH_CONNECT_TIMEOUT_MS = 30_000;              // TTFB only — cleared once headers arrive (not the whole transfer)
const IDLE_TIMEOUT_MS = 60_000;                       // abort if no chunk arrives for this long (anti-stall)
const MAX_REDIRECTS = 5;
const DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

class DownloadError extends Error {}

// ─────────────────────────── source resolution ───────────────────────────

function isWithinStreamRoot(p: string): boolean {
  // Resolve the root through any symlinks too (e.g. macOS /tmp → /private/tmp),
  // so a realpath'd target compares against a realpath'd root — otherwise a
  // legitimate file reads as "outside" purely from the tmpdir symlink.
  let root = path.resolve(STREAM_ROOT);
  try { root = fs.realpathSync(STREAM_ROOT); } catch { /* root may not exist yet */ }
  const rel = path.relative(root, path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isPrivateV4(o: number[]): boolean {
  return (
    o[0] === 0 || o[0] === 127 || o[0] === 10 ||
    (o[0] === 192 && o[1] === 168) ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 169 && o[1] === 254) ||        // link-local
    (o[0] === 100 && o[1] >= 64 && o[1] <= 127) // CGNAT
  );
}

/** Parse an IPv6 string (any form, incl. `::` compression and embedded IPv4)
 *  to its 16 bytes. `new URL().hostname` normalises v4-mapped addresses to hex
 *  (`::ffff:7f00:1`), so string matching is unreliable — we work on bytes. */
function ipv6ToBytes(input: string): Uint8Array | null {
  let s = input.replace(/^\[|\]$/g, '');
  if (net.isIP(s) !== 6) return null;
  const v4m = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s); // embedded IPv4 tail
  if (v4m) {
    const o = v4m[1].split('.').map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, v4m.index) + ':' + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = parseInt(groups[i] || '0', 16);
    if (Number.isNaN(g) || g < 0 || g > 0xffff) return null;
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 0xff;
  }
  return bytes;
}

function isPrivateIp(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, '');
  const fam = net.isIP(host);
  if (fam === 4) return isPrivateV4(host.split('.').map(Number));
  if (fam === 6) {
    const b = ipv6ToBytes(host);
    if (!b) return true; // unparseable IPv6 → treat as unsafe
    if (b.every((x) => x === 0)) return true;                                  // ::
    if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true;       // ::1
    if ((b[0] & 0xfe) === 0xfc) return true;                                    // fc00::/7 unique-local
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;                   // fe80::/10 link-local
    // v4-mapped ::ffff:a.b.c.d / v4-compatible ::a.b.c.d
    if (b.slice(0, 10).every((x) => x === 0) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
      return isPrivateV4([b[12], b[13], b[14], b[15]]);
    }
    // NAT64 64:ff9b::/96
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
      return isPrivateV4([b[12], b[13], b[14], b[15]]);
    }
    return false;
  }
  return false;
}

/** Parse + SSRF-guard a URL: http(s) only, and neither the literal host nor any
 *  DNS-resolved address may be private/loopback/link-local. Not bulletproof
 *  against DNS rebinding, but blocks the obvious metadata-endpoint / internal
 *  service reach. */
async function assertSafeUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new DownloadError('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new DownloadError('only http(s) URLs are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new DownloadError('refusing to fetch a private/loopback address');
    return u;
  }
  let addrs: Array<{ address: string }>;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new DownloadError(`cannot resolve host: ${host}`); }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new DownloadError('refusing to fetch a host that resolves to a private address');
  }
  return u;
}

interface DownloadSource {
  name: string;
  size: number; // 0 when unknown
  iterable: AsyncIterable<Uint8Array>;
  /** Force the underlying source closed (idle-timeout watchdog / abort). */
  abort?: () => void;
}

const asStr = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : '');
const asNum = (v: JsonValue | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Follow redirects MANUALLY, SSRF-guarding every hop. Default fetch follows
 *  redirects automatically and would NOT re-check the target, so a public URL
 *  could 302 to a private/metadata address — re-validating each Location closes
 *  that. Each hop gets a TTFB-only timeout (cleared once headers arrive, so a
 *  legitimate slow/large body isn't cut mid-transfer); the final hop's
 *  AbortController is returned so the caller's idle watchdog can kill a stalled
 *  body. (DNS rebinding between our check and undici's own connect remains a
 *  known residual — it needs connect-time peer-IP validation to fully close.) */
async function fetchGuarded(rawUrl: string): Promise<{ resp: Response; abort: () => void }> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertSafeUrl(current);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), FETCH_CONNECT_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(u, { headers: { 'User-Agent': DOWNLOAD_USER_AGENT }, redirect: 'manual', signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      await resp.body?.cancel().catch(() => { /* ignore */ });
      if (!loc) throw new DownloadError(`download failed: ${resp.status} redirect without Location`);
      current = new URL(loc, u).toString();
      continue;
    }
    return { resp, abort: () => ac.abort() };
  }
  throw new DownloadError('download failed: too many redirects');
}

async function openUrl(rawUrl: string, name: string, knownSize: number): Promise<DownloadSource> {
  const { resp, abort } = await fetchGuarded(rawUrl);
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => { /* ignore */ });
    throw new DownloadError(`download failed: HTTP ${resp.status}`);
  }
  const declared = Number(resp.headers.get('content-length') ?? '');
  const size = (Number.isFinite(declared) && declared > 0 ? declared : 0) || knownSize;
  if (!resp.body) throw new DownloadError('download failed: empty response body');
  return { name: name || urlBasename(rawUrl), size, iterable: resp.body as unknown as AsyncIterable<Uint8Array>, abort };
}

function urlBasename(u: string): string {
  try {
    const name = path.basename(new URL(u).pathname);
    return name && name !== '/' ? decodeURIComponent(name) : 'download.bin';
  } catch { return 'download.bin'; }
}

async function resolveDownload(
  target: string,
  ctx: ApiActionContext,
  prefer: 'auto' | 'image' | 'record',
  chunkSize: number,
): Promise<DownloadSource> {
  // 1. local file — but ONLY a real existing file, fenced inside the stream
  //    temp root. `resolveLocalFilePath` returns the input verbatim for any
  //    non-URL string (including cached-media ids), so we must NOT treat a
  //    non-existent "path" as local — that would shadow the cached-media branch
  //    below (the whole point of the *_image/_record_stream actions).
  const local = resolveLocalFilePath(target);
  if (local) {
    let st: fs.Stats | null = null;
    try { st = fs.statSync(local); } catch { st = null; }
    if (st?.isFile()) {
      // Fence against the *real* path so a symlink inside the root can't point
      // out (lexical resolve alone would follow it).
      let real = local;
      try { real = fs.realpathSync(local); } catch { /* keep lexical */ }
      if (!isWithinStreamRoot(real)) throw new DownloadError('local downloads are restricted to the stream temp directory');
      const rs = fs.createReadStream(real, { highWaterMark: chunkSize });
      return { name: path.basename(real), size: st.size, iterable: rs, abort: () => rs.destroy() };
    }
  }

  // 2. explicit http(s) URL.
  if (/^https?:\/\//i.test(target)) return openUrl(target, '', 0);

  // 3. cached image / voice id → QQ CDN URL.
  let info: JsonObject | null = null;
  if (prefer !== 'record') info = await ctx.getImageInfo(target);
  if (!info && prefer !== 'image') info = await ctx.getRecordInfo(target);
  if (info) {
    const url = asStr(info.url) || asStr(info.file);
    if (/^https?:\/\//i.test(url)) return openUrl(url, asStr(info.file_name), asNum(info.file_size));
  }

  throw new DownloadError('file not found (expected a stream-dir path, an http(s) URL, or a cached image/voice id)');
}

// ─────────────────────────── push engine ───────────────────────────

async function streamChunks(
  sink: StreamSink,
  iterable: AsyncIterable<Uint8Array>,
  totalSize: number,
  dataType: string,
  abort?: () => void,
): Promise<{ totalChunks: number; totalBytes: number }> {
  let index = 0;
  let bytesRead = 0;
  // Anti-stall: if no chunk arrives for IDLE_TIMEOUT_MS, force the source closed
  // so a server that sends headers then hangs can't pin a socket forever (the
  // sink's own liveness check only fires when we actually send a frame).
  let idle: NodeJS.Timeout | null = null;
  const armIdle = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { abort?.(); }, IDLE_TIMEOUT_MS);
    if (idle.unref) idle.unref();
  };
  armIdle();
  try {
    for await (const part of iterable) {
      armIdle();
      const buf = Buffer.isBuffer(part) ? part : Buffer.from(part);
      bytesRead += buf.length;
      if (bytesRead > MAX_DOWNLOAD_BYTES) throw new DownloadError(`download exceeds size limit (${MAX_DOWNLOAD_BYTES} bytes)`);
      const b64 = buf.toString('base64');
      await sink.send({
        type: StreamStatus.Stream,
        data_type: dataType,
        index,
        data: b64,
        size: buf.length,
        progress: totalSize > 0 ? Math.min(100, Math.round((bytesRead / totalSize) * 100)) : 0,
        base64_size: b64.length,
      });
      index++;
    }
  } finally {
    if (idle) clearTimeout(idle);
  }
  return { totalChunks: index, totalBytes: bytesRead };
}

async function runDownload(
  target: string,
  chunkSizeReq: number | undefined,
  ctx: ApiActionContext,
  sink: StreamSink,
  prefer: 'auto' | 'image' | 'record',
): Promise<ApiResponse> {
  if (!target) throw new DownloadError('file is required');
  let chunkSize = chunkSizeReq && chunkSizeReq > 0 ? chunkSizeReq : DEFAULT_CHUNK_BYTES;
  if (chunkSize > MAX_CHUNK_REQUEST_BYTES) chunkSize = MAX_CHUNK_REQUEST_BYTES;

  const src = await resolveDownload(target, ctx, prefer, chunkSize);
  await sink.send({
    type: StreamStatus.Stream,
    data_type: 'file_info',
    file_name: src.name,
    file_size: src.size,
    chunk_size: chunkSize,
  });
  const { totalChunks, totalBytes } = await streamChunks(sink, src.iterable, src.size, 'file_chunk', src.abort);
  return okResponse({
    type: StreamStatus.Response,
    data_type: 'file_complete',
    file_name: src.name,
    total_chunks: totalChunks,
    total_bytes: totalBytes,
    message: 'Download completed',
  });
}

// ─────────────────────────── action definitions ───────────────────────────

const downloadParams = {
  file: f.string().optional().describe('文件路径(限 stream 临时目录)/ http(s) URL'),
  file_id: f.string().optional().describe('文件 ID(缓存的图片/语音 id)'),
  chunk_size: f.int({ min: 1 }).optional().describe('分块大小(字节,默认 64KB)'),
};

const downloadFileStream = defineStreamAction({
  name: 'download_file_stream',
  summary: '以流式方式下载文件(stream 目录本地文件 / URL / 缓存媒体)',
  returns: '流式帧:file_info → file_chunk* → file_complete',
  params: downloadParams,
  run: (p, ctx, _raw, sink) => runDownload(p.file || p.file_id || '', p.chunk_size, ctx, sink, 'auto'),
});

const downloadFileImageStream = defineStreamAction({
  name: 'download_file_image_stream',
  summary: '以流式方式下载图片(缓存图片 id / URL / stream 目录本地文件)',
  returns: '流式帧:file_info → file_chunk* → file_complete',
  params: downloadParams,
  run: (p, ctx, _raw, sink) => runDownload(p.file || p.file_id || '', p.chunk_size, ctx, sink, 'image'),
});

const downloadFileRecordStream = defineStreamAction({
  name: 'download_file_record_stream',
  summary: '以流式方式下载语音(缓存语音 id / URL / stream 目录本地文件)',
  returns: '流式帧:file_info → file_chunk* → file_complete',
  params: downloadParams,
  run: (p, ctx, _raw, sink) => runDownload(p.file || p.file_id || '', p.chunk_size, ctx, sink, 'record'),
});

const testDownloadStream = defineStreamAction({
  name: 'test_download_stream',
  summary: '测试下载流(推送 10 个数据帧,验证流式传输,不触达 QQ)',
  returns: '流式帧:data_chunk*10 → data_complete(error=true 时以 error 帧结束)',
  params: { error: f.bool().default(false).describe('是否触发测试错误') },
  run: async (p, _ctx, _raw, sink) => {
    for (let i = 0; i < 10; i++) {
      await sink.send({ type: StreamStatus.Stream, data: `Index-> ${i + 1}`, data_type: 'data_chunk' });
    }
    if (p.error) throw new DownloadError('This is a test error');
    return okResponse({ type: StreamStatus.Response, data_type: 'data_complete', data: 'Stream transmission complete' });
  },
});

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  downloadFileStream.register(h, ctx);
  downloadFileImageStream.register(h, ctx);
  downloadFileRecordStream.register(h, ctx);
  testDownloadStream.register(h, ctx);
}

// Exposed for tests.
export const __test = { resolveDownload, isWithinStreamRoot, isPrivateIp, assertSafeUrl, streamChunks, runDownload };
