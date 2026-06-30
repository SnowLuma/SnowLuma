// debug-tools — backend for the debug console's two heavier endpoints
// (Phase 2 of the debug-console expansion):
//
//   • POST /api/debug/invoke-stream — drive a Stream API action and relay every
//     frame to the browser over an SSE body. Unlike the live-activity stream
//     (debug-stream.ts), this MUST NOT drop frames: a file transfer that loses a
//     chunk is corrupt. So backpressure is handled by *waiting* for the consumer
//     to drain, never by dropping.
//   • POST /api/debug/upload — stream a browser-selected file to a temp path on
//     the SERVER (the bot runs on the server, not the user's machine), so the
//     returned path can be fed to a send action. Streamed straight to disk with a
//     byte cap — never buffered whole, so large videos don't blow up memory.
//
// The pure pieces live here (path sanitisation, the size-capped disk sink, the
// stream-invoke Response builder) so they are unit-testable away from Hono.

import { createWriteStream } from 'fs';
import { mkdir, readdir, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

/** Temp dir for browser→server uploads. Siblings the Stream API's temp root but
 *  kept distinct so the two cleanup stories don't entangle. */
export const DEBUG_UPLOAD_DIR = path.join(os.tmpdir(), 'snowluma-debug-upload');

/** Hard ceiling on a single upload. Mirrors the Stream API's upload cap. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB

/** Uploads older than this are swept on the next upload (best-effort). */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Reduce a client-supplied filename to a safe basename (extension preserved),
 *  with no path separators or traversal. The client path is NEVER trusted for
 *  placement — this is only used to keep the stored name human-readable. */
export function safeUploadName(raw: string | undefined): string {
  // Treat both separators as path delimiters, then take the basename so any
  // `../` / absolute prefix is discarded regardless of host platform.
  const base = path.basename(String(raw ?? '').replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[^\w.\-]+/g, '_') // collapse anything exotic to underscore
    .replace(/^\.+/, '')        // no leading dots (no hidden / '..' names)
    .slice(0, 120);
  return cleaned || 'file';
}

/** Unguessable destination path under DEBUG_UPLOAD_DIR for a sanitised name.
 *  Throws if the composed path would escape the dir (defence in depth — it
 *  can't, given the random id + basename, but we assert anyway). */
export function uploadDestPath(safeName: string): string {
  const id = randomBytes(12).toString('hex');
  const dest = path.join(DEBUG_UPLOAD_DIR, `${id}__${safeName}`);
  const rel = path.relative(DEBUG_UPLOAD_DIR, dest);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('invalid upload path');
  }
  return dest;
}

/** Stream raw request-body bytes to a temp file under DEBUG_UPLOAD_DIR, enforcing
 *  a byte cap. Returns the final server path + byte size. On overflow or any
 *  error the partial file is removed and the call rejects. Never buffers the
 *  whole body. */
export async function streamUploadToDisk(
  body: ReadableStream<Uint8Array> | null,
  filename: string | undefined,
  opts: { maxBytes?: number } = {},
): Promise<{ path: string; size: number }> {
  if (!body) throw new Error('empty body');
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  await mkdir(DEBUG_UPLOAD_DIR, { recursive: true });
  void sweepOldUploads(); // fire-and-forget TTL cleanup

  const dest = uploadDestPath(safeUploadName(filename));
  const out = createWriteStream(dest, { mode: 0o600 });
  // A WriteStream emits 'error' ASYNCHRONOUSLY (ENOSPC / EIO / quota) during a
  // background flush — typically while we're parked at reader.read() or waiting
  // on 'drain'. An unhandled 'error' event would crash the whole process, and a
  // backpressured error would leave 'drain' to never fire (a forever-hung await
  // + leaked fd). So turn it into a rejection and race it into every await; the
  // catch below then destroys + unlinks the partial.
  const errored = new Promise<never>((_, rej) => out.once('error', rej));
  errored.catch(() => { /* swallow a late error after success (still raced below) */ });
  let size = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await Promise.race([errored, reader.read()]);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('上传超出大小上限');
      // Respect the write stream's backpressure (but never hang on an error).
      if (!out.write(value)) {
        await Promise.race([errored, new Promise<void>((res) => out.once('drain', res))]);
      }
    }
    await Promise.race([errored, new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())))]);
    if (size === 0) throw new Error('empty body');
    return { path: dest, size };
  } catch (err) {
    // Wait for the stream to fully close BEFORE unlinking: createWriteStream
    // opens the fd asynchronously, so a fast failure can reach `rm` before the
    // file even exists on disk — then the late open would re-create it and leak
    // the partial. 'close' guarantees the fd is settled and no more writes land.
    out.destroy();
    if (!out.closed) await new Promise<void>((res) => out.once('close', () => res()));
    await rm(dest, { force: true }).catch(() => { /* best-effort */ });
    throw err;
  }
}

/** Remove upload temp files older than the TTL. Best-effort; never throws. */
export async function sweepOldUploads(now: number = Date.now()): Promise<number> {
  let removed = 0;
  try {
    const names = await readdir(DEBUG_UPLOAD_DIR);
    await Promise.all(
      names.map(async (n) => {
        const p = path.join(DEBUG_UPLOAD_DIR, n);
        try {
          const s = await stat(p);
          if (now - s.mtimeMs > UPLOAD_TTL_MS) {
            await rm(p, { force: true, recursive: true });
            removed += 1;
          }
        } catch { /* racing cleanup / vanished file */ }
      }),
    );
  } catch { /* dir absent yet */ }
  return removed;
}

/** Drives a stream-capable action and relays its frames. The driver is the
 *  instance's `invokeStream` (which itself handles non-stream actions by emitting
 *  a single frame). */
export type StreamInvokeDriver = (
  rawRequest: string,
  emit: (json: string) => Promise<void>,
  isAlive: () => boolean,
) => Promise<void>;

/** How long emit() will wait for a backed-up consumer to drain before it gives
 *  up waiting and enqueues anyway (the request abort / action idle-watchdog are
 *  the real stall guards). */
const DRAIN_WAIT_MS = 20;
const DRAIN_MAX_SPINS = 3000; // 3000 * 20ms ≈ 60s

/** Build the SSE `Response` for `/api/debug/invoke-stream`: each relayed frame
 *  is one `data: <json>\n\n` event; no frame is ever dropped. A driver error
 *  becomes a terminal `failed` frame. Closing the request (signal abort) stops
 *  delivery. `delay` is injectable for tests. */
export function buildStreamInvokeResponse(
  driver: StreamInvokeDriver,
  rawRequest: string,
  signal: AbortSignal,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const onAbort = () => { closed = true; };
      signal.addEventListener('abort', onAbort);
      const isAlive = () => !closed && !signal.aborted;

      const emit = async (json: string): Promise<void> => {
        if (!isAlive()) throw new Error('stream transport closed');
        // Backpressure WITHOUT dropping: wait for the consumer to catch up.
        let spins = 0;
        while (isAlive() && (controller.desiredSize ?? 1) <= 0 && spins < DRAIN_MAX_SPINS) {
          await delay(DRAIN_WAIT_MS);
          spins += 1;
        }
        if (!isAlive()) throw new Error('stream transport closed');
        controller.enqueue(encoder.encode(`data: ${json}\n\n`));
      };

      try {
        await driver(rawRequest, emit, isAlive);
      } catch (err) {
        if (isAlive()) {
          const msg = err instanceof Error ? err.message : 'stream error';
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: 'failed', retcode: 1400, message: msg, wording: msg })}\n\n`));
          } catch { /* controller already torn down */ }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
