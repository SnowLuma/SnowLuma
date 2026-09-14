// hashFileStreaming is the streaming replacement for the buffered
// `computeHashes` + `computeVideoSha1Blocks` (+ head-md5) used before an
// upload. The refactor's whole promise is byte-for-byte identity, so this
// test IS the oracle: for a spread of sizes around the 1 MiB block boundary
// (and a spread of head limits around chunk boundaries) it asserts the
// streaming result equals the buffered functions over the same bytes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { hashFileStreaming, hashFlashFileStreaming } from '@snowluma/protocol/highway/hash-file';
import { computeHashes, computeMd5 } from '@snowluma/protocol/highway/utils';
import { computeSha1StateV } from '@snowluma/protocol/highway/sha1-stream';
import { computeVideoSha1Blocks } from '@snowluma/protocol/highway/video-upload';

const MB = 1024 * 1024;

function synth(size: number): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 131 + 7) & 0xff;
  return b;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

describe('hashFileStreaming ≡ buffered computeHashes + computeVideoSha1Blocks + head-md5', () => {
  let dir: string;
  beforeAll(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sl-hash-')); });
  afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  // Sizes chosen around the 1 MiB block boundary + sub-block + multi-block.
  const SIZES = [0, 1, 63, 64, 65, MB - 1, MB, MB + 1, 2 * MB, 2 * MB + 123];

  for (const size of SIZES) {
    it(`size=${size}: md5 / sha1 / sha1Blocks match the buffered helpers`, async () => {
      const data = synth(size);
      const file = path.join(dir, `${randomUUID()}.bin`);
      fs.writeFileSync(file, data);

      const streamed = await hashFileStreaming(file);
      const buffered = computeHashes(data);
      const refBlocks = computeVideoSha1Blocks(data);

      expect(eq(streamed.md5, buffered.md5)).toBe(true);
      expect(eq(streamed.sha1, buffered.sha1)).toBe(true);
      expect(streamed.md5Hex).toBe(buffered.md5Hex);
      expect(streamed.sha1Hex).toBe(buffered.sha1Hex);
      expect(streamed.headMd5).toBeUndefined();

      // sha1Blocks must match exactly — same count, same bytes, same order.
      expect(streamed.sha1Blocks.length).toBe(refBlocks.length);
      for (let i = 0; i < refBlocks.length; i++) {
        expect(eq(streamed.sha1Blocks[i]!, refBlocks[i]!)).toBe(true);
      }
    });
  }

  it('headMd5 matches computeMd5(first N bytes) across boundaries (±1, block edge, ≥size)', async () => {
    const size = 2 * MB + 500;
    const data = synth(size);
    const file = path.join(dir, `${randomUUID()}.bin`);
    fs.writeFileSync(file, data);

    // head limits: empty, tiny, mid-first-block, exact block boundary ±1,
    // and past the end (must clamp to size).
    const limits = [0, 1, 1000, MB - 1, MB, MB + 1, size - 1, size, size + 1];
    for (const L of limits) {
      const streamed = await hashFileStreaming(file, { headLimit: L });
      const ref = computeMd5(data.subarray(0, Math.min(data.length, L)));
      expect(streamed.headMd5).toBeDefined();
      expect(eq(streamed.headMd5!, ref)).toBe(true);
      // The rest of the digests are unaffected by headLimit.
      expect(streamed.md5Hex).toBe(computeHashes(data).md5Hex);
    }
  });

  it('empty file: md5/sha1 of nothing, single finalized sha1 block, headMd5 of empty', async () => {
    const file = path.join(dir, `${randomUUID()}.bin`);
    fs.writeFileSync(file, new Uint8Array(0));
    const streamed = await hashFileStreaming(file, { headLimit: 10 });
    const buffered = computeHashes(new Uint8Array(0));
    expect(streamed.md5Hex).toBe(buffered.md5Hex);
    expect(streamed.sha1Hex).toBe(buffered.sha1Hex);
    expect(streamed.sha1Blocks.length).toBe(1); // just the finalized whole-file sha1
    expect(eq(streamed.sha1Blocks[0]!, buffered.sha1)).toBe(true);
    expect(eq(streamed.headMd5!, computeMd5(new Uint8Array(0)))).toBe(true);
  });
});

// Flash sliceupload Sha1StateV is NOT video sha1Blocks. Both snapshot
// un-finalized SHA1 at 1 MiB boundaries, but flash omits the un-finalized
// snapshot of the last full slice — that slot is the finalized whole-file
// SHA1. Reusing sha1Blocks when size % 1 MiB === 0 ships an extra state
// and the server rejects the upload.
describe('hashFlashFileStreaming ≡ buffered computeHashes + computeSha1StateV', () => {
  let dir: string;
  beforeAll(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sl-flash-hash-')); });
  afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  const SIZES = [0, 1, 63, 64, 65, MB - 1, MB, MB + 1, 2 * MB, 2 * MB + 123];

  for (const size of SIZES) {
    it(`size=${size}: md5 / sha1 / Sha1StateV match the buffered flash helpers`, async () => {
      const data = synth(size);
      const file = path.join(dir, `${randomUUID()}.bin`);
      fs.writeFileSync(file, data);

      const streamed = await hashFlashFileStreaming(file);
      const buffered = computeHashes(data);
      const sliceCount = Math.ceil(size / MB);
      const refState = computeSha1StateV(data, sliceCount, MB);

      expect(eq(streamed.md5, buffered.md5)).toBe(true);
      expect(eq(streamed.sha1, buffered.sha1)).toBe(true);
      expect(streamed.md5Hex).toBe(buffered.md5Hex);
      expect(streamed.sha1Hex).toBe(buffered.sha1Hex);
      expect(streamed.sliceCount).toBe(sliceCount);
      expect(streamed.sha1StateV.length).toBe(refState.length);
      for (let i = 0; i < refState.length; i++) {
        expect(eq(streamed.sha1StateV[i]!, refState[i]!)).toBe(true);
      }
    });
  }

  it('exact 1 MiB is not video sha1Blocks (no extra un-finalized last-slice state)', async () => {
    const data = synth(MB);
    const file = path.join(dir, `${randomUUID()}.bin`);
    fs.writeFileSync(file, data);

    const flash = await hashFlashFileStreaming(file);
    const video = await hashFileStreaming(file);
    expect(flash.sha1StateV.length).toBe(1);
    expect(video.sha1Blocks.length).toBe(2);
    expect(eq(flash.sha1StateV[0]!, video.sha1Blocks[1]!)).toBe(true);
    expect(eq(flash.sha1StateV[0]!, video.sha1Blocks[0]!)).toBe(false);
  });

  it('exact 2 MiB: flash has 2 states, video sha1Blocks has 3', async () => {
    const data = synth(2 * MB);
    const file = path.join(dir, `${randomUUID()}.bin`);
    fs.writeFileSync(file, data);

    const flash = await hashFlashFileStreaming(file);
    const video = await hashFileStreaming(file);
    expect(flash.sliceCount).toBe(2);
    expect(flash.sha1StateV.length).toBe(2);
    expect(video.sha1Blocks.length).toBe(3);
    expect(eq(flash.sha1StateV[0]!, video.sha1Blocks[0]!)).toBe(true);
    expect(eq(flash.sha1StateV[1]!, video.sha1Blocks[2]!)).toBe(true);
  });
});
