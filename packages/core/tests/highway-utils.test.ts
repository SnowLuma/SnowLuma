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

describe('loadBinarySource HTTP header hardening', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends a browser User-Agent on the first attempt, without a Referer', async () => {
    const calls: Array<Record<string, string>> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;

    await loadBinarySource('https://example.test/a.png', 'image');
    expect(calls).toHaveLength(1);
    expect(calls[0]['User-Agent']).toMatch(/Mozilla\/5\.0/);
    expect(calls[0]['Referer']).toBeUndefined();
  });

  it('retries with a Referer when the first fetch fails at the network level', async () => {
    // Reproduces the reported bug: an anti-bot front-end resets the
    // header-less request → undici `TypeError: fetch failed`. The retry
    // carries a Referer pointing at the resource itself and succeeds.
    const calls: Array<Record<string, string>> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push((init?.headers ?? {}) as Record<string, string>);
      if (calls.length === 1) throw new TypeError('fetch failed');
      return new Response(new Uint8Array([9, 9]), { status: 200 });
    }) as typeof fetch;

    const loaded = await loadBinarySource('https://img.example.test/x.gif', 'image');
    expect(Array.from(loaded.bytes)).toEqual([9, 9]);
    expect(calls).toHaveLength(2);
    expect(calls[0]['Referer']).toBeUndefined();
    expect(calls[1]['Referer']).toBe('https://img.example.test/x.gif');
  });

  it('retries with a Referer on a 403 (anti-hotlink)', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      if (n === 1) return new Response(new Uint8Array(0), { status: 403 });
      return new Response(new Uint8Array([7]), { status: 200 });
    }) as typeof fetch;

    const loaded = await loadBinarySource('https://cdn.example.test/y.jpg', 'image');
    expect(Array.from(loaded.bytes)).toEqual([7]);
    expect(n).toBe(2);
  });

  it('does not retry a size-limit rejection (deterministic, no second download)', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(0), {
      status: 200,
      headers: { 'content-length': String(10 * 1024 * 1024) },
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      loadBinarySource('https://example.test/big.bin', 'image', 1024),
    ).rejects.toThrow(/too large/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the first error when the Referer retry also fails', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n++;
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    await expect(
      loadBinarySource('https://example.test/z.png', 'image'),
    ).rejects.toThrow(/fetch failed/);
    expect(n).toBe(2);
  });
});
