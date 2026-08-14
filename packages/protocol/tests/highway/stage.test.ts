import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import fs, { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { STAGE_DIR, stageSourceToDisk, sweepStagedUploads } from '@snowluma/protocol/highway/stage';

const DOWNLOAD_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const STAGE_TTL_MS = 30 * 60 * 1000;
const SNOW_BYTES = Buffer.from([0x53, 0x4e, 0x4f, 0x57]);

const live: Array<{ cleanup(): Promise<void> }> = [];
let scratch = '';

function hold<T extends { cleanup(): Promise<void> }>(staged: T): T {
  live.push(staged);
  return staged;
}

async function stageNames(): Promise<string[]> {
  try {
    return await fsp.readdir(STAGE_DIR);
  } catch {
    return [];
  }
}

async function newPartNames(before: readonly string[]): Promise<string[]> {
  const prior = new Set(before);
  return (await stageNames()).filter((name) => name.endsWith('.part') && !prior.has(name));
}

function expectStagedPath(filePath: string, ext: string): void {
  expect(filePath.startsWith(`${STAGE_DIR}${path.sep}`)).toBe(true);
  expect(path.basename(filePath)).toMatch(
    new RegExp(`^stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${ext.replaceAll('.', '\\.')}$`),
  );
}

beforeEach(async () => {
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'sl-proto-stage-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (live.length > 0) {
    await live.pop()!.cleanup();
  }
  await fsp.rm(scratch, { recursive: true, force: true });
});

describe('STAGE_DIR', () => {
  it('is os.tmpdir()/media-stage', () => {
    expect(STAGE_DIR).toBe(path.join(os.tmpdir(), 'media-stage'));
  });
});

describe('stageSourceToDisk — empty / classification', () => {
  it('rejects an empty source before touching disk', async () => {
    const before = await stageNames();
    await expect(stageSourceToDisk('', 64)).rejects.toThrow('stage source is empty');
    expect(await stageNames()).toEqual(before);
  });

  it('rejects a data URL that is missing the comma separator', async () => {
    await expect(stageSourceToDisk('data:image/png;base64', 64)).rejects.toThrow(
      'data URL source is missing its payload separator',
    );
  });

  it('rejects a data URL that is not base64-encoded', async () => {
    await expect(stageSourceToDisk('data:text/plain,hello', 64)).rejects.toThrow(
      'data URL source must use base64 encoding',
    );
  });

  it('rejects a missing local path via realpath', async () => {
    const missing = path.join(scratch, 'no-such-file.bin');
    await expect(stageSourceToDisk(missing, 64)).rejects.toThrow(/ENOENT/);
  });
});

describe('stageSourceToDisk — base64', () => {
  it('writes base64:// bytes to a .bin stage file with an empty fileName', async () => {
    const staged = hold(await stageSourceToDisk('base64://U05PVw==', 64));
    expect(staged.fileSize).toBe(4);
    expect(staged.fileName).toBe('');
    expectStagedPath(staged.filePath, '.bin');
    expect(await fsp.readFile(staged.filePath)).toEqual(SNOW_BYTES);
  });

  it('accepts a case-insensitive BASE64:// prefix and one-byte padding', async () => {
    const staged = hold(await stageSourceToDisk('BASE64:///w==', 1));
    expect(staged.fileSize).toBe(1);
    expect(staged.fileName).toBe('');
    expect(await fsp.readFile(staged.filePath)).toEqual(Buffer.from([0xff]));
  });

  it('accepts two-byte and three-byte payloads at the decoded-size ceiling', async () => {
    const two = hold(await stageSourceToDisk('base64://AAA=', 2));
    const three = hold(await stageSourceToDisk('base64://AAAA', 3));
    expect(two.fileSize).toBe(2);
    expect(three.fileSize).toBe(3);
    expect(await fsp.readFile(two.filePath)).toEqual(Buffer.from([0x00, 0x00]));
    expect(await fsp.readFile(three.filePath)).toEqual(Buffer.from([0x00, 0x00, 0x00]));
  });

  it('stages an RFC 2397 data URL and keeps fileName empty', async () => {
    const staged = hold(await stageSourceToDisk('data:image/png;base64,U05PVw==', 4));
    expect(staged.fileSize).toBe(4);
    expect(staged.fileName).toBe('');
    expect(await fsp.readFile(staged.filePath)).toEqual(SNOW_BYTES);
  });

  it('accepts DATA:…;BASE64, payloads (case-insensitive metadata)', async () => {
    const staged = hold(await stageSourceToDisk('DATA:application/octet-stream;BASE64,AA==', 1));
    expect(staged.fileSize).toBe(1);
    expect(await fsp.readFile(staged.filePath)).toEqual(Buffer.from([0x00]));
  });

  it('strips non-base64 characters before the decoded-length check', async () => {
    const staged = hold(await stageSourceToDisk('base64://U05P\nVw==', 4));
    expect(staged.fileSize).toBe(4);
    expect(await fsp.readFile(staged.filePath)).toEqual(SNOW_BYTES);
  });

  it('stages an empty base64:// payload as a zero-byte file', async () => {
    const staged = hold(await stageSourceToDisk('base64://', 0));
    expect(staged.fileSize).toBe(0);
    expect(staged.fileName).toBe('');
    expect(await fsp.readFile(staged.filePath)).toEqual(Buffer.alloc(0));
  });

  it('rejects oversized base64 on decoded length and leaves no new .part', async () => {
    const before = await stageNames();
    await expect(stageSourceToDisk('base64://aGVsbG8=', 4)).rejects.toThrow('stage source too large: 5 > 4');
    expect(await newPartNames(before)).toEqual([]);
  });

  it('rejects an oversized data URL on decoded length and leaves no new .part', async () => {
    const before = await stageNames();
    await expect(stageSourceToDisk('data:audio/ogg;base64,aGVsbG8=', 4)).rejects.toThrow(
      'stage source too large: 5 > 4',
    );
    expect(await newPartNames(before)).toEqual([]);
  });

  it('unlinks the .part when finalize rename fails', async () => {
    const before = await stageNames();
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('rename failed'));
    await expect(stageSourceToDisk('base64://U05PVw==', 64)).rejects.toThrow('rename failed');
    expect(await newPartNames(before)).toEqual([]);
  });
});

describe('stageSourceToDisk — http', () => {
  it('streams the body to disk and uses the decoded URL basename', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(Uint8Array.from([0x10, 0x20, 0x30, 0x40]), { status: 200 })),
    );
    const staged = hold(await stageSourceToDisk('https://media.example.test/packs/clip%20v2.mp4?sig=9', 64));
    expect(staged.fileName).toBe('clip v2.mp4');
    expect(staged.fileSize).toBe(4);
    expectStagedPath(staged.filePath, '.bin');
    expect(await fsp.readFile(staged.filePath)).toEqual(Buffer.from([0x10, 0x20, 0x30, 0x40]));
  });

  it('keeps fileName empty when the URL has no basename', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.from([0x7f]), { status: 200 })));
    const staged = hold(await stageSourceToDisk('https://media.example.test/', 8));
    expect(staged.fileName).toBe('');
    expect(staged.fileSize).toBe(1);
    expect(await fsp.readFile(staged.filePath)).toEqual(Buffer.from([0x7f]));
  });

  it('creates an empty staged file for an empty HTTP body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(0), { status: 200 })));
    const staged = hold(await stageSourceToDisk('HTTP://cdn.example.test/empty.bin', 8));
    expect(staged.fileName).toBe('empty.bin');
    expect(staged.fileSize).toBe(0);
    expect(await fsp.readFile(staged.filePath)).toEqual(Buffer.alloc(0));
  });

  it('rejects a declared Content-Length overflow without retrying and leaves no .part', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(80), {
      status: 200,
      headers: { 'content-length': '80' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const before = await stageNames();
    await expect(stageSourceToDisk('https://cdn.example.test/huge.bin', 16)).rejects.toThrow(
      'stage too large: 80 > 16',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await newPartNames(before)).toEqual([]);
  });

  it('rejects a streamed overflow after the sink opened and discards the .part', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10).fill(0x11));
        controller.enqueue(new Uint8Array(10).fill(0x22));
        controller.enqueue(new Uint8Array(10).fill(0x33));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));
    const before = await stageNames();
    await expect(stageSourceToDisk('https://cdn.example.test/stream.bin', 16)).rejects.toThrow(
      'stage too large: > 16',
    );
    expect(await newPartNames(before)).toEqual([]);
  });

  it('retries once with Referer after a non-size failure and stages the retry body', async () => {
    const url = 'https://media.example.test/packs/retry.bin';
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (!headers.Referer) throw new TypeError('fetch failed');
      expect(headers.Referer).toBe(url);
      expect(headers['User-Agent']).toBe(DOWNLOAD_UA);
      expect(headers.Accept).toBe('*/*');
      expect(init?.redirect).toBe('follow');
      return new Response(Uint8Array.from([0xaa, 0xbb, 0xcc]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const staged = hold(await stageSourceToDisk(url, 32));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(staged.fileSize).toBe(3);
    expect(await fsp.readFile(staged.filePath)).toEqual(Buffer.from([0xaa, 0xbb, 0xcc]));
  });

  it('surfaces the first HTTP status error when the Referer retry also fails', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(stageSourceToDisk('https://cdn.example.test/down.bin', 32)).rejects.toThrow(
      'HTTP download failed: 503',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('unlinks the http .part when rename after download fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(Uint8Array.from([0x01, 0x02]), { status: 200 })),
    );
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('http rename failed'));
    const before = await stageNames();
    await expect(stageSourceToDisk('https://cdn.example.test/r.bin', 32)).rejects.toThrow(
      'http rename failed',
    );
    expect(await newPartNames(before)).toEqual([]);
  });
});

describe('stageSourceToDisk — local files', () => {
  it('hardlinks a raw path, preserves basename, and pins the inode after source unlink', async () => {
    const src = path.join(scratch, 'payload.dat');
    await fsp.writeFile(src, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const srcStat = await fsp.stat(src);
    const staged = hold(await stageSourceToDisk(src, 64));
    expect(staged.fileName).toBe('payload.dat');
    expect(staged.fileSize).toBe(4);
    expectStagedPath(staged.filePath, '.dat');
    const stagedStat = await fsp.stat(staged.filePath);
    expect(stagedStat.ino).toBe(srcStat.ino);
    expect(stagedStat.nlink).toBe(2);
    await fsp.unlink(src);
    expect(await fsp.readFile(staged.filePath)).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  });

  it('accepts a file:// URL and uses the pre-resolution basename', async () => {
    const src = path.join(scratch, 'video.mp4');
    await fsp.writeFile(src, Buffer.from([0x00, 0x00, 0x00, 0x18]));
    const staged = hold(await stageSourceToDisk(pathToFileURL(src).href, 64));
    expect(staged.fileName).toBe('video.mp4');
    expect(staged.fileSize).toBe(4);
    expectStagedPath(staged.filePath, '.mp4');
    expect(await fsp.readFile(staged.filePath)).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x18]));
  });

  it('resolves a symlink target but keeps the symlink basename and extension', async () => {
    const target = path.join(scratch, 'blob-real.bin');
    const linkPath = path.join(scratch, 'alias.mov');
    await fsp.writeFile(target, Buffer.from([0x6d, 0x6f, 0x6f, 0x76]));
    await fsp.symlink(target, linkPath);
    const staged = hold(await stageSourceToDisk(linkPath, 64));
    expect(staged.fileName).toBe('alias.mov');
    expectStagedPath(staged.filePath, '.mov');
    expect(await fsp.readFile(staged.filePath)).toEqual(Buffer.from([0x6d, 0x6f, 0x6f, 0x76]));
  });

  it('uses .bin when the local path has no extension', async () => {
    const src = path.join(scratch, 'noext');
    await fsp.writeFile(src, Buffer.from([0x42]));
    const staged = hold(await stageSourceToDisk(src, 8));
    expect(staged.fileName).toBe('noext');
    expectStagedPath(staged.filePath, '.bin');
  });

  it('preserves a mixed-case extension on the staged path', async () => {
    const src = path.join(scratch, 'Photo.JPEG');
    await fsp.writeFile(src, Buffer.from([0xff, 0xd8]));
    const staged = hold(await stageSourceToDisk(src, 8));
    expect(staged.fileName).toBe('Photo.JPEG');
    expectStagedPath(staged.filePath, '.JPEG');
  });

  it('allows a local file whose size equals maxBytes', async () => {
    const src = path.join(scratch, 'exact.bin');
    await fsp.writeFile(src, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    const staged = hold(await stageSourceToDisk(src, 8));
    expect(staged.fileSize).toBe(8);
  });

  it('stages an empty regular file', async () => {
    const src = path.join(scratch, 'zero.dat');
    await fsp.writeFile(src, Buffer.alloc(0));
    const staged = hold(await stageSourceToDisk(src, 0));
    expect(staged.fileSize).toBe(0);
    expect(staged.fileName).toBe('zero.dat');
    expect(await fsp.readFile(staged.filePath)).toEqual(Buffer.alloc(0));
  });

  it('rejects a directory before creating a stage file', async () => {
    await expect(stageSourceToDisk(scratch, 64)).rejects.toThrow(
      `stage source is not a regular file: ${scratch}`,
    );
  });

  it('rejects an oversized local file before staging', async () => {
    const src = path.join(scratch, 'huge.bin');
    await fsp.writeFile(src, Buffer.alloc(80, 0xab));
    await expect(stageSourceToDisk(src, 16)).rejects.toThrow('stage source too large: 80 > 16');
  });

  it('copies when link() fails and the copy survives source deletion', async () => {
    const src = path.join(scratch, 'xfs.bin');
    const payload = Buffer.from([0xc0, 0xff, 0xee, 0x11]);
    await fsp.writeFile(src, payload);
    const srcIno = (await fsp.stat(src)).ino;
    const linkSpy = vi.spyOn(fsp, 'link').mockRejectedValueOnce(
      Object.assign(new Error('EXDEV'), { code: 'EXDEV' }),
    );
    const staged = hold(await stageSourceToDisk(src, 64));
    expect(linkSpy).toHaveBeenCalledOnce();
    expect(staged.fileName).toBe('xfs.bin');
    expect(staged.fileSize).toBe(4);
    expect((await fsp.stat(staged.filePath)).ino).not.toBe(srcIno);
    await fsp.unlink(src);
    expect(await fsp.readFile(staged.filePath)).toEqual(payload);
  });

  it('cleans temps when both link() and the copy fallback fail', async () => {
    const src = path.join(scratch, 'fail.bin');
    await fsp.writeFile(src, Buffer.from([0x01]));
    vi.spyOn(fsp, 'link').mockRejectedValueOnce(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));
    vi.spyOn(fsp, 'copyFile').mockRejectedValueOnce(new Error('ENOSPC: copy failed'));
    const before = await stageNames();
    await expect(stageSourceToDisk(src, 64)).rejects.toThrow('ENOSPC: copy failed');
    expect(await newPartNames(before)).toEqual([]);
  });

  it('cleans temps when link() fails and the copy rename fails', async () => {
    const src = path.join(scratch, 'rename-fail.bin');
    await fsp.writeFile(src, Buffer.from([0x02, 0x03]));
    vi.spyOn(fsp, 'link').mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('copy rename failed'));
    const before = await stageNames();
    await expect(stageSourceToDisk(src, 64)).rejects.toThrow('copy rename failed');
    expect(await newPartNames(before)).toEqual([]);
  });
});

describe('stageSourceToDisk — cleanup', () => {
  it('removes only the staged temp, never the caller file, and is idempotent', async () => {
    const src = path.join(scratch, 'keep-me.bin');
    await fsp.writeFile(src, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const staged = hold(await stageSourceToDisk(src, 64));
    expect(fs.existsSync(staged.filePath)).toBe(true);
    await staged.cleanup();
    expect(fs.existsSync(staged.filePath)).toBe(false);
    expect(fs.existsSync(src)).toBe(true);
    expect(await fsp.readFile(src)).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    await expect(staged.cleanup()).resolves.toBeUndefined();
  });

  it('tolerates the staged path already being gone', async () => {
    const src = path.join(scratch, 'gone.bin');
    await fsp.writeFile(src, Buffer.from([0x09]));
    const staged = hold(await stageSourceToDisk(src, 64));
    await fsp.unlink(staged.filePath);
    await expect(staged.cleanup()).resolves.toBeUndefined();
  });
});

describe('sweepStagedUploads', () => {
  it('returns 0 when the stage directory does not exist', async () => {
    const parked = `${STAGE_DIR}.park-${randomUUID()}`;
    let moved = false;
    try {
      try {
        await fsp.rename(STAGE_DIR, parked);
        moved = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      await expect(sweepStagedUploads(2_000_000_000_000)).resolves.toBe(0);
    } finally {
      if (moved) {
        await fsp.rm(STAGE_DIR, { recursive: true, force: true }).catch(() => undefined);
        await fsp.rename(parked, STAGE_DIR);
      }
    }
  });

  it('reaps a temp older than 30 minutes, keeps a TTL-edge temp, and skips an active staged file', async () => {
    const src = path.join(scratch, 'inflight.bin');
    await fsp.writeFile(src, Buffer.from([0x51, 0x52]));
    const staged = hold(await stageSourceToDisk(src, 64));

    await fsp.mkdir(STAGE_DIR, { recursive: true });
    const now = 2_000_000_000_000;
    const aged = path.join(STAGE_DIR, `stage-${randomUUID()}.aged`);
    const edge = path.join(STAGE_DIR, `stage-${randomUUID()}.edge`);
    const recent = path.join(STAGE_DIR, `stage-${randomUUID()}.recent`);
    await fsp.writeFile(aged, Buffer.from('aged-orphan'));
    await fsp.writeFile(edge, Buffer.from('ttl-edge'));
    await fsp.writeFile(recent, Buffer.from('fresh-orphan'));
    // Age by whole seconds: some filesystems store mtime at 1s resolution, so a
    // 1ms-past-TTL stamp can round back onto the keep side of `> 30min`.
    await fsp.utimes(aged, new Date(now), new Date(now - STAGE_TTL_MS - 1000));
    await fsp.utimes(edge, new Date(now), new Date(now - STAGE_TTL_MS));
    await fsp.utimes(recent, new Date(now), new Date(now));
    await fsp.utimes(staged.filePath, new Date(now - STAGE_TTL_MS - 1000), new Date(now - STAGE_TTL_MS - 1000));

    try {
      const removed = await sweepStagedUploads(now);
      expect(fs.existsSync(aged)).toBe(false);
      expect(fs.existsSync(edge)).toBe(true);
      expect(fs.existsSync(recent)).toBe(true);
      expect(fs.existsSync(staged.filePath)).toBe(true);
      expect(removed).toBeGreaterThanOrEqual(1);
    } finally {
      await fsp.rm(edge, { force: true });
      await fsp.rm(recent, { force: true });
      await fsp.rm(aged, { force: true });
    }
  });

  it('uses Date.now() when now is omitted', async () => {
    await fsp.mkdir(STAGE_DIR, { recursive: true });
    const orphan = path.join(STAGE_DIR, `stage-${randomUUID()}.epoch`);
    await fsp.writeFile(orphan, Buffer.from('epoch-orphan'));
    await fsp.utimes(orphan, new Date('1990-01-01T00:00:00.000Z'), new Date('1990-01-01T00:00:00.000Z'));
    try {
      const removed = await sweepStagedUploads();
      expect(fs.existsSync(orphan)).toBe(false);
      expect(removed).toBeGreaterThanOrEqual(1);
    } finally {
      await fsp.rm(orphan, { force: true });
    }
  });
});
