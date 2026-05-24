import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBinarySource, resolveLocalFilePath } from '@snowluma/protocol/highway/utils';

describe('highway source paths', () => {
  it('normalizes file URLs with an extra leading slash on POSIX', () => {
    if (process.platform === 'win32') return;
    expect(resolveLocalFilePath('file:////AstrBot/data/plugin/cache/BV-test.mp4'))
      .toBe('/AstrBot/data/plugin/cache/BV-test.mp4');
  });

  it('loads encoded file URLs from the local filesystem', async () => {
    const filePath = path.join(os.tmpdir(), `snowluma video ${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(filePath, 'ok');

    try {
      const source = pathToFileURL(filePath).href;
      const loaded = await loadBinarySource(source, 'test file');
      expect(Buffer.from(loaded.bytes).toString('utf8')).toBe('ok');
      expect(loaded.fileName).toBe(path.basename(filePath));
    } finally {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  });
});

describe('loadBinarySource maxBytes enforcement', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rejects HTTP downloads larger than maxBytes via streaming, even without Content-Length', async () => {
    // Streamed chunk-encoded response: no Content-Length, totals > cap.
    const chunkSize = 4 * 1024;
    const totalChunks = 16;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < totalChunks; i++) controller.enqueue(new Uint8Array(chunkSize));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { /* no content-length */ },
    })) as typeof fetch;

    // Cap below total: 16*4096 = 65536, cap 32 KiB → should throw mid-stream.
    await expect(
      loadBinarySource('https://example.test/big.bin', 'test', 32 * 1024),
    ).rejects.toThrow(/too large/);
  });

  it('rejects HTTP downloads when Content-Length already exceeds maxBytes', async () => {
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array(0), {
      status: 200,
      headers: { 'content-length': String(10 * 1024 * 1024) },
    })) as typeof fetch;

    await expect(
      loadBinarySource('https://example.test/big.bin', 'test', 1024),
    ).rejects.toThrow(/too large: 10485760/);
  });

  it('accepts a streamed download that fits inside maxBytes', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn(async () => new Response(stream, { status: 200 })) as typeof fetch;

    const loaded = await loadBinarySource('https://example.test/small.bin', 'test', 1024);
    expect(Array.from(loaded.bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects oversized local files via fs.stat before reading them', async () => {
    const filePath = path.join(os.tmpdir(), `snowluma-binary-cap-${process.pid}-${Date.now()}.bin`);
    fs.writeFileSync(filePath, Buffer.alloc(128));
    try {
      await expect(
        loadBinarySource(filePath, 'test', 64),
      ).rejects.toThrow(/too large: 128 > 64/);
    } finally {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  });

  it('rejects oversized base64 payloads', async () => {
    const big = Buffer.alloc(128).toString('base64');
    await expect(
      loadBinarySource(`base64://${big}`, 'test', 64),
    ).rejects.toThrow(/too large: 128 > 64/);
  });
});
