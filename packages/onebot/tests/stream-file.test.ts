// Phase 2 — upload_file_stream + clean_stream_temp_file (#163).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';
import { __test, STREAM_UPLOAD_DIR } from '../src/actions/stream-file';

const { handleUpload, cleanDir, uploads } = __test;
type UP = Parameters<typeof handleUpload>[0];

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64');

// Fill every optional key so the direct handleUpload calls satisfy the type.
function mk(p: Partial<UP> & { stream_id: string }): UP {
  return {
    chunk_data: undefined, chunk_index: undefined, total_chunks: undefined,
    file_size: undefined, expected_sha256: undefined, is_complete: undefined,
    filename: undefined, reset: undefined, verify_only: undefined,
    file_retention: 0, ...p,
  };
}

afterEach(() => {
  cleanDir(STREAM_UPLOAD_DIR);
  uploads.clear();
});

describe('upload_file_stream', () => {
  it('reassembles ordered chunks into a file with correct content + sha256', async () => {
    const id = 'up-ordered';
    const parts = ['hello ', 'streamed ', 'world!'];
    const full = parts.join('');
    const sha = createHash('sha256').update(full).digest('hex');

    let r = await handleUpload(mk({ stream_id: id, total_chunks: 3, chunk_index: 0, chunk_data: b64(parts[0]) }));
    expect(r.data).toMatchObject({ type: 'stream', status: 'chunk_received', received_chunks: 1, total_chunks: 3 });
    await handleUpload(mk({ stream_id: id, total_chunks: 3, chunk_index: 1, chunk_data: b64(parts[1]) }));
    r = await handleUpload(mk({ stream_id: id, total_chunks: 3, chunk_index: 2, chunk_data: b64(parts[2]) }));
    expect(r.data).toMatchObject({ received_chunks: 3 });

    r = await handleUpload(mk({ stream_id: id, total_chunks: 3, is_complete: true, expected_sha256: sha }));
    const data = r.data as Record<string, unknown>;
    expect(data).toMatchObject({ type: 'response', status: 'file_complete', total_chunks: 3, file_size: full.length, sha256: sha });
    expect(fs.readFileSync(String(data.file_path), 'utf8')).toBe(full);
    // state dropped after completion, chunk dir gone
    expect(uploads.has(id)).toBe(false);
  });

  it('accepts out-of-order chunks and dedups repeats idempotently', async () => {
    const id = 'up-ooo';
    await handleUpload(mk({ stream_id: id, total_chunks: 3, chunk_index: 2, chunk_data: b64('C') }));
    await handleUpload(mk({ stream_id: id, total_chunks: 3, chunk_index: 0, chunk_data: b64('A') }));
    // duplicate of an already-received chunk → no double count
    const dup = await handleUpload(mk({ stream_id: id, total_chunks: 3, chunk_index: 2, chunk_data: b64('C') }));
    expect(dup.data).toMatchObject({ received_chunks: 2 });
    await handleUpload(mk({ stream_id: id, total_chunks: 3, chunk_index: 1, chunk_data: b64('B') }));
    const r = await handleUpload(mk({ stream_id: id, total_chunks: 3, is_complete: true }));
    expect(fs.readFileSync(String((r.data as Record<string, unknown>).file_path), 'utf8')).toBe('ABC');
  });

  it('rejects completion with a missing chunk', async () => {
    const id = 'up-missing';
    await handleUpload(mk({ stream_id: id, total_chunks: 2, chunk_index: 0, chunk_data: b64('only') }));
    await expect(handleUpload(mk({ stream_id: id, total_chunks: 2, is_complete: true }))).rejects.toThrow(/missing/i);
  });

  it('rejects a sha256 mismatch and deletes the bad file', async () => {
    const id = 'up-sha';
    await handleUpload(mk({ stream_id: id, total_chunks: 1, chunk_index: 0, chunk_data: b64('data') }));
    await expect(handleUpload(mk({ stream_id: id, total_chunks: 1, is_complete: true, expected_sha256: 'deadbeef' }))).rejects.toThrow(/sha256 mismatch/i);
    // A failed completion keeps the stream (client can reset+retry; the reaper
    // reclaims it if abandoned), but the corrupt merged file is deleted.
    expect(uploads.has(id)).toBe(true);
    expect(fs.existsSync(uploads.get(id)!.finalPath)).toBe(false);
  });

  it('rejects an out-of-range chunk index and a new stream without total_chunks', async () => {
    await expect(handleUpload(mk({ stream_id: 'up-oob', total_chunks: 2, chunk_index: 5, chunk_data: b64('x') }))).rejects.toThrow(/invalid chunk index/i);
    await expect(handleUpload(mk({ stream_id: 'up-no-total', chunk_index: 0, chunk_data: b64('x') }))).rejects.toThrow(/total_chunks required/i);
  });

  it('reset discards the stream (surfaced as an error, NapCat parity)', async () => {
    const id = 'up-reset';
    await handleUpload(mk({ stream_id: id, total_chunks: 2, chunk_index: 0, chunk_data: b64('x') }));
    expect(uploads.has(id)).toBe(true);
    await expect(handleUpload(mk({ stream_id: id, reset: true }))).rejects.toThrow(/reset/i);
    expect(uploads.has(id)).toBe(false);
  });

  it('verify_only reports status, errors on unknown stream', async () => {
    const id = 'up-verify';
    await handleUpload(mk({ stream_id: id, total_chunks: 4, chunk_index: 0, chunk_data: b64('x') }));
    const r = await handleUpload(mk({ stream_id: id, verify_only: true }));
    expect(r.data).toMatchObject({ type: 'stream', received_chunks: 1, total_chunks: 4 });
    await expect(handleUpload(mk({ stream_id: 'nope', verify_only: true }))).rejects.toThrow(/not found/i);
  });

  it('strips path separators from filename (no temp-dir escape)', async () => {
    const id = 'up-escape';
    await handleUpload(mk({ stream_id: id, total_chunks: 1, chunk_index: 0, chunk_data: b64('x'), filename: '../../evil.sh' }));
    const r = await handleUpload(mk({ stream_id: id, total_chunks: 1, is_complete: true }));
    const fp = String((r.data as Record<string, unknown>).file_path);
    expect(path.dirname(fp)).toBe(STREAM_UPLOAD_DIR);
    expect(fp).not.toContain('..');
  });
});

describe('upload_file_stream hardening', () => {
  it('rejects path-traversal / illegal stream_id (no escape) [C1]', async () => {
    const evil = ['../../../../tmp/victim', '..', 'a/b', 'a\\b', 'with space', 'x'.repeat(129), '', 'dot.dot'];
    for (const id of evil) {
      await expect(handleUpload(mk({ stream_id: id, total_chunks: 1, chunk_index: 0, chunk_data: b64('x') }))).rejects.toThrow(/invalid stream_id/i);
    }
    // a benign traversal attempt left nothing outside the upload dir
    expect(fs.existsSync('/tmp/victim')).toBe(false);
    // validateStreamId accepts UUID-ish ids, rejects separators/dots
    expect(() => __test.validateStreamId('uuid-1234-5678_ABCdef')).not.toThrow();
    expect(() => __test.validateStreamId('../x')).toThrow();
    expect(() => __test.validateStreamId('a/b')).toThrow();
    expect(() => __test.validateStreamId('a.b')).toThrow();
  });

  it('rejects total_chunks above the cap [M1]', async () => {
    await expect(handleUpload(mk({ stream_id: 'up-huge', total_chunks: __test.MAX_CHUNKS + 1, chunk_index: 0, chunk_data: b64('x') }))).rejects.toThrow(/total_chunks exceeds limit/i);
  });

  it('caps concurrent streams [M2]', async () => {
    for (let i = 0; i < __test.MAX_CONCURRENT_STREAMS; i++) {
      await handleUpload(mk({ stream_id: `cap-${i}`, total_chunks: 2, chunk_index: 0, chunk_data: b64('x') }));
    }
    await expect(handleUpload(mk({ stream_id: 'cap-overflow', total_chunks: 2, chunk_index: 0, chunk_data: b64('x') }))).rejects.toThrow(/too many concurrent/i);
  });

  it('counts a concurrently-duplicated chunk index only once [M3]', async () => {
    const id = 'up-race';
    const [a, b] = await Promise.all([
      handleUpload(mk({ stream_id: id, total_chunks: 3, chunk_index: 0, chunk_data: b64('A') })),
      handleUpload(mk({ stream_id: id, total_chunks: 3, chunk_index: 0, chunk_data: b64('A') })),
    ]);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(uploads.get(id)!.written.size).toBe(1);
    expect(uploads.get(id)!.claimed.size).toBe(1);
  });
});

describe('upload_file_stream via the streaming dispatch', () => {
  it('emits a stream-marked chunk frame end-to-end', async () => {
    const h = new ApiHandler({} as ApiActionContext);
    expect(h.isStreamAction('upload_file_stream')).toBe(true);

    const frames: string[] = [];
    await h.processStreamRequest(
      JSON.stringify({ action: 'upload_file_stream', params: { stream_id: 'ws-up', total_chunks: 1, chunk_index: 0, chunk_data: b64('hi') }, echo: 'E' }),
      (j) => frames.push(j),
    );
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0])).toMatchObject({
      status: 'ok', stream: 'stream-action', echo: 'E',
      data: { type: 'stream', status: 'chunk_received', received_chunks: 1, total_chunks: 1 },
    });
  });
});

describe('clean_stream_temp_file', () => {
  it('removes stream temp entries and is scoped to the stream dirs', async () => {
    fs.mkdirSync(STREAM_UPLOAD_DIR, { recursive: true });
    const f1 = path.join(STREAM_UPLOAD_DIR, 'leftover.bin');
    fs.writeFileSync(f1, 'junk');
    // an unrelated temp file outside the stream dir must survive
    const outside = path.join(os.tmpdir(), `snowluma-stream-unrelated-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'keep');

    const h = new ApiHandler({} as ApiActionContext);
    const r = await h.handle('clean_stream_temp_file', {});
    expect(r.status).toBe('ok');
    expect((r.data as Record<string, unknown>).message).toBe('success');
    expect(fs.existsSync(f1)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    fs.rmSync(outside, { force: true });
  });
});
