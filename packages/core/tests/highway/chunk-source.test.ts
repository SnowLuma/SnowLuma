// ChunkSource is the buffer-or-disk abstraction the highway PUT loop reads
// through (#stream-upload). The whole streaming refactor rests on one
// invariant: a FileChunkSource must yield BYTE-FOR-BYTE the same chunks as a
// BufferChunkSource over the same file, at every (offset, length) the uploader
// asks for. These tests are that byte-oracle.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { BufferChunkSource, FileChunkSource } from '@snowluma/protocol/highway';

// Mirrors highway-client's HIGHWAY_BLOCK_SIZE chunk walk without the network:
// step through [0,size) in `block` strides, last chunk short by construction.
async function collectChunks(src: { size: number; read(o: number, l: number): Promise<Uint8Array> }, block: number) {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < src.size) {
    const len = Math.min(block, src.size - offset);
    chunks.push(new Uint8Array(await src.read(offset, len)));
    offset += len;
  }
  return chunks;
}

describe('ChunkSource — FileChunkSource ≡ BufferChunkSource', () => {
  let dir: string;
  beforeAll(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sl-chunk-')); });
  afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  // Sizes chosen around block boundaries: exact multiple, +1, -1, tiny, empty.
  for (const [label, size, block] of [
    ['empty', 0, 7],
    ['tiny (< block)', 5, 7],
    ['exact multiple', 21, 7],
    ['one past a boundary', 22, 7],
    ['one before a boundary', 20, 7],
    ['single full block', 7, 7],
  ] as const) {
    it(`${label}: chunks + size are byte-identical (size=${size}, block=${block})`, async () => {
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
      const file = path.join(dir, `${randomUUID()}.bin`);
      fs.writeFileSync(file, data);

      const buf = new BufferChunkSource(data);
      const fch = await FileChunkSource.open(file, size);
      try {
        expect(fch.size).toBe(buf.size);
        expect(fch.size).toBe(size);
        const a = await collectChunks(buf, block);
        const b = await collectChunks(fch, block);
        expect(b.length).toBe(a.length);
        for (let i = 0; i < a.length; i++) {
          expect(Buffer.from(b[i]!).equals(Buffer.from(a[i]!))).toBe(true);
        }
        // Reassembled stream equals the original bytes exactly.
        expect(Buffer.concat(b.map((c) => Buffer.from(c))).equals(Buffer.from(data))).toBe(true);
      } finally {
        await fch.close();
      }
    });
  }

  it('FileChunkSource.read returns EXACTLY the requested length (no short read leaks)', async () => {
    const data = new Uint8Array(1000).map((_, i) => (i * 13) & 0xff);
    const file = path.join(dir, `${randomUUID()}.bin`);
    fs.writeFileSync(file, data);
    const fch = await FileChunkSource.open(file, data.length);
    try {
      for (const [off, len] of [[0, 1], [0, 1000], [37, 200], [999, 1], [500, 500]] as const) {
        const got = await fch.read(off, len);
        expect(got.length).toBe(len);
        expect(Buffer.from(got).equals(Buffer.from(data.subarray(off, off + len)))).toBe(true);
      }
    } finally {
      await fch.close();
    }
  });

  it('FileChunkSource.read throws on unexpected EOF (request past end)', async () => {
    const data = new Uint8Array(10);
    const file = path.join(dir, `${randomUUID()}.bin`);
    fs.writeFileSync(file, data);
    const fch = await FileChunkSource.open(file, 10);
    try {
      await expect(fch.read(5, 20)).rejects.toThrow(/unexpected EOF/);
    } finally {
      await fch.close();
    }
  });

  it('BufferChunkSource.close and FileChunkSource.close both resolve (idempotent contract)', async () => {
    const buf = new BufferChunkSource(new Uint8Array(3));
    await expect(buf.close()).resolves.toBeUndefined();
    const file = path.join(dir, `${randomUUID()}.bin`);
    fs.writeFileSync(file, new Uint8Array(3));
    const fch = await FileChunkSource.open(file, 3);
    await expect(fch.close()).resolves.toBeUndefined();
  });
});
