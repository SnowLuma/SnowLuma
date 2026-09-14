// stageSourceToDisk unifies every upload source onto a local disk path so the
// streaming uploader never buffers a whole file. These tests cover the three
// source kinds, the crash-safety contract (hardlink survives caller-side
// deletion — the retention race Codex flagged), size caps, symlink resolution,
// cleanup, and the orphan reaper's active-set safety.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { stageSourceToDisk, sweepStagedUploads, STAGE_DIR } from '@snowluma/protocol/highway/stage';
import { pathToFileURL } from 'url';

const originalFetch = globalThis.fetch;
let scratch: string;

async function readStaged(p: string): Promise<Buffer> {
  return fsp.readFile(p);
}

beforeEach(async () => { scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'sl-stage-src-')); });
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await fsp.rm(scratch, { recursive: true, force: true });
});

describe('stageSourceToDisk — base64', () => {
  it('stages base64 bytes to disk', async () => {
    const data = Buffer.from('hello base64 world');
    const staged = await stageSourceToDisk(`base64://${data.toString('base64')}`, 1024);
    try {
      expect(staged.fileSize).toBe(data.length);
      expect(staged.fileName).toBe('');
      expect((await readStaged(staged.filePath)).equals(data)).toBe(true);
      expect(staged.filePath.startsWith(STAGE_DIR)).toBe(true);
    } finally { await staged.cleanup(); }
  });

  it('stages base64 data URLs to disk', async () => {
    const data = Buffer.from('hello data URL');
    const staged = await stageSourceToDisk(
      `data:audio/webm;codecs=opus;base64,${data.toString('base64')}`,
      1024,
    );
    try {
      expect(staged.fileSize).toBe(data.length);
      expect(staged.fileName).toBe('');
      expect((await readStaged(staged.filePath)).equals(data)).toBe(true);
    } finally { await staged.cleanup(); }
  });

  it('rejects oversized base64 on decoded length (before allocation) and leaves no temp', async () => {
    const big = Buffer.alloc(4096).toString('base64');
    await expect(stageSourceToDisk(`base64://${big}`, 64)).rejects.toThrow(/too large/);
    const parts = (await fsp.readdir(STAGE_DIR).catch(() => [] as string[])).filter((n) => n.endsWith('.part'));
    expect(parts).toEqual([]);
  });

  it('rejects oversized base64 data URLs before allocation and leaves no temp', async () => {
    const big = Buffer.alloc(4096).toString('base64');
    await expect(
      stageSourceToDisk(`data:audio/webm;base64,${big}`, 64),
    ).rejects.toThrow(/too large/);
    const parts = (await fsp.readdir(STAGE_DIR).catch(() => [] as string[])).filter((n) => n.endsWith('.part'));
    expect(parts).toEqual([]);
  });
});

describe('stageSourceToDisk — http', () => {
  it('streams an http download to disk with the URL basename', async () => {
    const body = new Uint8Array([9, 8, 7, 6, 5]);
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const staged = await stageSourceToDisk('https://example.test/clip.mp4', 1024);
    try {
      expect(staged.fileName).toBe('clip.mp4');
      expect(staged.fileSize).toBe(body.length);
      expect((await readStaged(staged.filePath)).equals(Buffer.from(body))).toBe(true);
    } finally { await staged.cleanup(); }
  });

  it('rejects an oversized http download and cleans up the .part', async () => {
    globalThis.fetch = (async () => new Response(new Uint8Array(4096), {
      status: 200, headers: { 'content-length': '4096' },
    })) as typeof fetch;
    await expect(stageSourceToDisk('https://example.test/big.bin', 64)).rejects.toThrow(/too large/);
    const leftover = (await fsp.readdir(STAGE_DIR).catch(() => [] as string[])).filter((n) => n.endsWith('.part'));
    expect(leftover).toEqual([]);
  });

  it('rejects a STREAMED overflow (no Content-Length) after the sink+.part exist, then cleans up', async () => {
    // No content-length → the size cap only trips mid-stream, AFTER fileSink has
    // opened the .part. This exercises fileSink.discard()'s close-before-unlink.
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(4096)); c.close(); },
    });
    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as typeof fetch;
    await expect(stageSourceToDisk('https://example.test/stream.bin', 4 * 1024)).rejects.toThrow(/too large/);
    const parts = (await fsp.readdir(STAGE_DIR).catch(() => [] as string[])).filter((n) => n.endsWith('.part'));
    expect(parts).toEqual([]);
  });

  it('retries with a Referer after a network failure and stages the retry body cleanly (no attempt-1 leftovers)', async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed'); // anti-bot RST on attempt 1
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const staged = await stageSourceToDisk('https://example.test/r.mp4', 1024);
    try {
      expect(n).toBe(2);
      expect(staged.fileSize).toBe(body.length);
      expect((await readStaged(staged.filePath)).equals(Buffer.from(body))).toBe(true);
    } finally { await staged.cleanup(); }
  });
});

describe('stageSourceToDisk — local files', () => {
  it('hardlinks a local file:// source and survives caller-side deletion (retention race)', async () => {
    const src = path.join(scratch, 'video.mp4');
    const data = Buffer.from('the caller-owned temp that retention will delete');
    fs.writeFileSync(src, data);

    const staged = await stageSourceToDisk(pathToFileURL(src).href, 1 << 20);
    try {
      expect(staged.fileName).toBe('video.mp4');
      expect(staged.fileSize).toBe(data.length);
      // Simulate upload_file_stream's retention timer unlinking the original
      // BETWEEN the hash pass and the upload pass.
      await fsp.unlink(src);
      // The hardlink kept the inode alive — the staged path is still fully readable.
      expect((await readStaged(staged.filePath)).equals(data)).toBe(true);
    } finally { await staged.cleanup(); }
  });

  it('accepts a raw local path and preserves its basename', async () => {
    const src = path.join(scratch, 'doc.bin');
    fs.writeFileSync(src, Buffer.from([1, 2, 3, 4]));
    const staged = await stageSourceToDisk(src, 1 << 20);
    try {
      expect(staged.fileName).toBe('doc.bin');
      expect(staged.fileSize).toBe(4);
    } finally { await staged.cleanup(); }
  });

  it('resolves a symlink to its target but keeps the symlink basename', async () => {
    const target = path.join(scratch, 'real-xyz.tmp');
    const linkPath = path.join(scratch, 'friendly.mp4');
    const data = Buffer.from('symlinked content');
    fs.writeFileSync(target, data);
    fs.symlinkSync(target, linkPath);
    const staged = await stageSourceToDisk(linkPath, 1 << 20);
    try {
      expect(staged.fileName).toBe('friendly.mp4'); // original basename, not the target's
      expect((await readStaged(staged.filePath)).equals(data)).toBe(true);
    } finally { await staged.cleanup(); }
  });

  it('falls back to a streamed copy when hardlink fails (e.g. cross-filesystem EXDEV)', async () => {
    const src = path.join(scratch, 'xfs.mp4');
    const data = Buffer.from('content that must copy when link() is refused');
    fs.writeFileSync(src, data);
    const linkSpy = vi.spyOn(fsp, 'link').mockRejectedValueOnce(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));
    try {
      const staged = await stageSourceToDisk(src, 1 << 20);
      try {
        expect(linkSpy).toHaveBeenCalledOnce();
        expect(staged.fileName).toBe('xfs.mp4');
        expect(staged.fileSize).toBe(data.length);
        expect((await readStaged(staged.filePath)).equals(data)).toBe(true);
        // The copy is an independent file — deleting the source leaves it intact.
        await fsp.unlink(src);
        expect((await readStaged(staged.filePath)).equals(data)).toBe(true);
      } finally { await staged.cleanup(); }
    } finally { linkSpy.mockRestore(); }
  });

  it('rejects a non-regular file (directory)', async () => {
    await expect(stageSourceToDisk(scratch, 1 << 20)).rejects.toThrow(/not a regular file/);
  });

  it('rejects an oversized local file before staging', async () => {
    const src = path.join(scratch, 'huge.bin');
    fs.writeFileSync(src, Buffer.alloc(200));
    await expect(stageSourceToDisk(src, 64)).rejects.toThrow(/too large: 200 > 64/);
  });
});

describe('stageSourceToDisk — cleanup + reaper', () => {
  it('cleanup removes the staged temp and is idempotent', async () => {
    const src = path.join(scratch, 'c.bin');
    fs.writeFileSync(src, Buffer.from([1]));
    const staged = await stageSourceToDisk(src, 1 << 20);
    expect(fs.existsSync(staged.filePath)).toBe(true);
    await staged.cleanup();
    expect(fs.existsSync(staged.filePath)).toBe(false);
    await expect(staged.cleanup()).resolves.toBeUndefined(); // idempotent, no throw
  });

  it('reaper removes an old ORPHAN temp but NEVER an in-flight (active) staged file', async () => {
    await fsp.mkdir(STAGE_DIR, { recursive: true });
    const old = Date.now() - 60 * 60 * 1000; // 1h ago

    // Orphan: a temp NOT tracked in `active` (as a crash would leave), aged out.
    const orphan = path.join(STAGE_DIR, `stage-${randomUUID()}.orphan`);
    fs.writeFileSync(orphan, Buffer.from('crash leftover'));
    fs.utimesSync(orphan, new Date(old), new Date(old));

    // In-flight: a real staged file (registered in `active`), also aged out —
    // the active-set must protect it from the age sweep.
    const src = path.join(scratch, 'inflight.bin');
    fs.writeFileSync(src, Buffer.from('being uploaded'));
    const staged = await stageSourceToDisk(src, 1 << 20);
    fs.utimesSync(staged.filePath, new Date(old), new Date(old)); // read-only upload → stale mtime

    const removed = await sweepStagedUploads(Date.now());
    expect(fs.existsSync(orphan)).toBe(false);           // orphan reaped
    expect(fs.existsSync(staged.filePath)).toBe(true);   // active file preserved
    expect(removed).toBeGreaterThanOrEqual(1);

    await staged.cleanup();
  });

  it('reaper leaves a recent orphan alone', async () => {
    await fsp.mkdir(STAGE_DIR, { recursive: true });
    const recent = path.join(STAGE_DIR, `stage-${randomUUID()}.recent`);
    fs.writeFileSync(recent, Buffer.from('fresh'));
    try {
      await sweepStagedUploads(Date.now());
      expect(fs.existsSync(recent)).toBe(true);
    } finally { await fsp.rm(recent, { force: true }); }
  });
});
