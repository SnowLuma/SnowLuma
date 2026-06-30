import { afterAll, describe, expect, it } from 'vitest';
import { readdir, readFile, rm } from 'fs/promises';
import path from 'path';
import {
  buildStreamInvokeResponse,
  DEBUG_UPLOAD_DIR,
  safeUploadName,
  streamUploadToDisk,
  uploadDestPath,
} from '../src/webui/debug-tools';

const written: string[] = [];
afterAll(async () => {
  await Promise.all(written.map((p) => rm(p, { force: true }).catch(() => {})));
});

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

async function readSse(res: Response): Promise<string[]> {
  const text = await res.text();
  return text.split('\n\n').filter((s) => s.startsWith('data: ')).map((s) => s.slice('data: '.length));
}

describe('safeUploadName', () => {
  it('strips path traversal and separators to a bare basename', () => {
    expect(safeUploadName('../../etc/passwd')).toBe('passwd');
    expect(safeUploadName('/abs/secret.key')).toBe('secret.key');
    expect(safeUploadName('a\\b\\c.png')).toBe('c.png');
    expect(safeUploadName('..')).toBe('file');       // leading dots stripped → empty → fallback
    expect(safeUploadName('...hidden')).toBe('hidden');
  });
  it('collapses exotic chars and falls back for empties', () => {
    expect(safeUploadName('my pic!@#.jpg')).toBe('my_pic_.jpg');
    expect(safeUploadName('')).toBe('file');
    expect(safeUploadName(undefined)).toBe('file');
  });
  it('keeps the extension and caps length', () => {
    const long = 'x'.repeat(500) + '.mp4';
    const out = safeUploadName(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.startsWith('x')).toBe(true);
  });
});

describe('uploadDestPath', () => {
  it('produces a unique path inside the upload dir', () => {
    const a = uploadDestPath('pic.png');
    const b = uploadDestPath('pic.png');
    expect(a).not.toBe(b); // random id prefix
    expect(path.dirname(a)).toBe(DEBUG_UPLOAD_DIR);
    expect(a.endsWith('__pic.png')).toBe(true);
    const rel = path.relative(DEBUG_UPLOAD_DIR, a);
    expect(rel.startsWith('..')).toBe(false);
    expect(path.isAbsolute(rel)).toBe(false);
  });
});

describe('streamUploadToDisk', () => {
  it('streams bytes to disk and reports the size', async () => {
    const data = new TextEncoder().encode('hello debug upload');
    const res = await streamUploadToDisk(streamOf(data.slice(0, 5), data.slice(5)), 'note.txt');
    written.push(res.path);
    expect(res.size).toBe(data.byteLength);
    expect(path.dirname(res.path)).toBe(DEBUG_UPLOAD_DIR);
    expect(await readFile(res.path, 'utf8')).toBe('hello debug upload');
  });

  it('rejects and removes the partial file when the cap is exceeded', async () => {
    const big = new Uint8Array(64);
    await expect(
      streamUploadToDisk(streamOf(big, big), 'big.bin', { maxBytes: 100 }),
    ).rejects.toThrow(/大小上限/);
    // the partial must not survive — no leftover `__big.bin` in the dir
    const names = await readdir(DEBUG_UPLOAD_DIR).catch(() => [] as string[]);
    expect(names.filter((n) => n.endsWith('__big.bin'))).toEqual([]);
  });

  it('rejects an empty body', async () => {
    await expect(streamUploadToDisk(null, 'x')).rejects.toThrow(/empty/);
    await expect(streamUploadToDisk(streamOf(), 'x')).rejects.toThrow(/empty/);
  });

  it('propagates a mid-transfer source error and removes the partial', async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial-bytes'));
        controller.error(new Error('source aborted'));
      },
    });
    await expect(streamUploadToDisk(failing, 'oops.bin')).rejects.toThrow(/source aborted/);
    const names = await readdir(DEBUG_UPLOAD_DIR).catch(() => [] as string[]);
    expect(names.filter((n) => n.endsWith('__oops.bin'))).toEqual([]);
  });
});

describe('buildStreamInvokeResponse', () => {
  const noDelay = async () => {};

  it('relays each emitted frame as one SSE event, in order', async () => {
    const ac = new AbortController();
    const driver = async (_rq: string, emit: (j: string) => Promise<void>) => {
      await emit(JSON.stringify({ data: { type: 'stream', i: 1 } }));
      await emit(JSON.stringify({ data: { type: 'stream', i: 2 } }));
      await emit(JSON.stringify({ status: 'ok', data: { type: 'response' } }));
    };
    const res = buildStreamInvokeResponse(driver, '{"action":"x"}', ac.signal, noDelay);
    const frames = (await readSse(res)).map((s) => JSON.parse(s));
    expect(frames).toHaveLength(3);
    expect(frames[0].data.i).toBe(1);
    expect(frames[2].data.type).toBe('response');
  });

  it('turns a driver error into a terminal failed frame', async () => {
    const ac = new AbortController();
    const driver = async (_rq: string, emit: (j: string) => Promise<void>) => {
      await emit(JSON.stringify({ data: { type: 'stream' } }));
      throw new Error('disk exploded');
    };
    const res = buildStreamInvokeResponse(driver, '{}', ac.signal, noDelay);
    const frames = (await readSse(res)).map((s) => JSON.parse(s));
    expect(frames).toHaveLength(2);
    expect(frames[1].status).toBe('failed');
    expect(frames[1].message).toMatch(/disk exploded/);
  });

  it('passes the raw request through to the driver', async () => {
    const ac = new AbortController();
    let seen = '';
    const driver = async (rq: string, emit: (j: string) => Promise<void>) => {
      seen = rq;
      await emit('{"data":{"type":"response"}}');
    };
    const res = buildStreamInvokeResponse(driver, '{"action":"test_download_stream"}', ac.signal, noDelay);
    await readSse(res);
    expect(seen).toBe('{"action":"test_download_stream"}');
  });

  it('exposes an SSE content-type', () => {
    const ac = new AbortController();
    const res = buildStreamInvokeResponse(async () => {}, '{}', ac.signal, noDelay);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
  });
});
