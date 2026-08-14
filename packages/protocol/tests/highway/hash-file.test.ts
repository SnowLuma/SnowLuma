// Streaming hasher must be byte-identical to the buffered helpers over the
// same bytes: computeHashes + computeVideoSha1Blocks (+ computeMd5 of the
// head) for hashFileStreaming, and computeHashes + computeSha1StateV for
// hashFlashFileStreaming. Flash Sha1StateV is not video sha1Blocks.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFileStreaming, hashFlashFileStreaming } from '@snowluma/protocol/highway/hash-file';
import { computeHashes, computeMd5 } from '@snowluma/protocol/highway/utils';
import { computeSha1StateV, Sha1Stream } from '@snowluma/protocol/highway/sha1-stream';
import { computeVideoSha1Blocks } from '../../src/highway/video-upload';

const MB = 1024 * 1024;

// Same generator as video-sha1-blocks.test.ts (and its golden-capture script).
function det(len: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

function hex(u: Uint8Array): string {
  return Buffer.from(u).toString('hex');
}

function nodeMd5Hex(data: Uint8Array): string {
  return createHash('md5').update(Buffer.from(data)).digest('hex');
}

function nodeSha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(Buffer.from(data)).digest('hex');
}

describe('hashFileStreaming', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sl-hash-file-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeBin(name: string, data: Uint8Array): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, data);
    return file;
  }

  it('empty file: well-known empty digests and a single finalized sha1 block', async () => {
    const file = await writeBin('empty.bin', new Uint8Array(0));
    const streamed = await hashFileStreaming(file);

    expect(streamed.md5Hex).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(streamed.sha1Hex).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(hex(streamed.md5)).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hex(streamed.sha1)).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(streamed.headMd5).toBeUndefined();
    expect(streamed.sha1Blocks.map(hex)).toEqual([
      'da39a3ee5e6b4b0d3255bfef95601890afd80709',
    ]);
  });

  it('empty file with headLimit still yields md5 of zero bytes', async () => {
    const file = await writeBin('empty-head.bin', new Uint8Array(0));
    const streamed = await hashFileStreaming(file, { headLimit: 10 });
    expect(hex(streamed.headMd5!)).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(streamed.md5Hex).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('sub-1 MiB file matches RFC hashes and has only the finalized sha1 block', async () => {
    const data = Buffer.from('abc', 'utf8');
    const file = await writeBin('abc.bin', data);
    const streamed = await hashFileStreaming(file);

    expect(streamed.md5Hex).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(streamed.sha1Hex).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(streamed.sha1Blocks.map(hex)).toEqual([
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    ]);
    expect(streamed.headMd5).toBeUndefined();
  });

  it('det(1000) matches computeHashes + computeVideoSha1Blocks + Node crypto', async () => {
    const data = det(1000);
    const file = await writeBin('det-1000.bin', data);
    const streamed = await hashFileStreaming(file);
    const buffered = computeHashes(data);

    expect(streamed.md5Hex).toBe(nodeMd5Hex(data));
    expect(streamed.sha1Hex).toBe(nodeSha1Hex(data));
    expect(hex(streamed.md5)).toBe(hex(buffered.md5));
    expect(hex(streamed.sha1)).toBe(hex(buffered.sha1));
    expect(streamed.md5Hex).toBe(buffered.md5Hex);
    expect(streamed.sha1Hex).toBe(buffered.sha1Hex);
    expect(streamed.sha1Blocks.map(hex)).toEqual(computeVideoSha1Blocks(data).map(hex));
    expect(streamed.sha1Blocks).toHaveLength(1);
  });

  it('exact 1 MiB emits an un-finalized boundary state then the overall sha1', async () => {
    const data = det(MB);
    const file = await writeBin('exact-1m.bin', data);
    const streamed = await hashFileStreaming(file);
    const overall = nodeSha1Hex(data);
    const prefixDigest = nodeSha1Hex(data); // whole file *is* the first slice
    const manual = new Sha1Stream();
    manual.update(data);

    expect(streamed.md5Hex).toBe(nodeMd5Hex(data));
    expect(streamed.sha1Hex).toBe(overall);
    expect(streamed.sha1Blocks).toHaveLength(2);
    expect(hex(streamed.sha1Blocks[0]!)).toBe(hex(manual.hash(true)));
    expect(hex(streamed.sha1Blocks[0]!)).not.toBe(prefixDigest);
    expect(hex(streamed.sha1Blocks[1]!)).toBe(overall);
    expect(streamed.sha1Blocks.map(hex)).toEqual(computeVideoSha1Blocks(data).map(hex));
  });

  it('2 MiB + 12345 reproduces the video-sha1-blocks golden states', async () => {
    const data = det(2 * MB + 12345);
    const file = await writeBin('golden-2m.bin', data);
    const streamed = await hashFileStreaming(file);

    expect(streamed.sha1Blocks.map(hex)).toEqual([
      'ab9a20fd6c98fc1f8f0c985cd552ff14c6feacfd',
      '2ccc5923b75f46ebd8ccb78e8c413c18025178b9',
      'dd9cfd4648ab460260afa820c98bfec1b17655d4',
    ]);
    expect(streamed.sha1Hex).toBe('dd9cfd4648ab460260afa820c98bfec1b17655d4');
    expect(streamed.md5Hex).toBe(nodeMd5Hex(data));
    expect(streamed.sha1Blocks.map(hex)).toEqual(computeVideoSha1Blocks(data).map(hex));
  });

  it('omitting opts leaves headMd5 undefined', async () => {
    const file = await writeBin('no-opts.bin', det(64));
    const streamed = await hashFileStreaming(file);
    expect(streamed.headMd5).toBeUndefined();
  });

  it('headLimit 0 is present and is the empty-md5', async () => {
    const file = await writeBin('head-0.bin', det(200));
    const streamed = await hashFileStreaming(file, { headLimit: 0 });
    expect(hex(streamed.headMd5!)).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(streamed.md5Hex).toBe(nodeMd5Hex(det(200)));
  });

  it('headMd5 is computeMd5 of the first N bytes inside the first 1 MiB chunk', async () => {
    const data = det(8000);
    const file = await writeBin('head-inside.bin', data);
    const streamed = await hashFileStreaming(file, { headLimit: 10 });
    expect(hex(streamed.headMd5!)).toBe(hex(computeMd5(data.subarray(0, 10))));
    expect(hex(streamed.headMd5!)).toBe(nodeMd5Hex(data.subarray(0, 10)));
  });

  it('headMd5 across a 1 MiB boundary matches computeMd5 of the clamped prefix', async () => {
    const data = det(MB + 500);
    const file = await writeBin('head-span.bin', data);
    const cases: Array<[number, number]> = [
      [MB - 1, MB - 1],
      [MB, MB],
      [MB + 1, MB + 1],
      [data.length + 1, data.length],
    ];
    for (const [limit, take] of cases) {
      const streamed = await hashFileStreaming(file, { headLimit: limit });
      expect(hex(streamed.headMd5!)).toBe(hex(computeMd5(data.subarray(0, take))));
      expect(streamed.md5Hex).toBe(nodeMd5Hex(data));
      expect(streamed.sha1Hex).toBe(nodeSha1Hex(data));
    }
  });

  it('rejects a missing path from stat before hashing', async () => {
    await expect(hashFileStreaming(join(dir, 'no-such.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('hashFlashFileStreaming', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sl-flash-hash-file-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeBin(name: string, data: Uint8Array): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, data);
    return file;
  }

  it('empty file: empty digests, sliceCount 0, no Sha1StateV entries', async () => {
    const file = await writeBin('empty.bin', new Uint8Array(0));
    const streamed = await hashFlashFileStreaming(file);

    expect(streamed.md5Hex).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(streamed.sha1Hex).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(streamed.sliceCount).toBe(0);
    expect(streamed.sha1StateV).toEqual([]);
  });

  it('sub-1 MiB file is a single finalized slice', async () => {
    const data = Buffer.from('abc', 'utf8');
    const file = await writeBin('abc.bin', data);
    const streamed = await hashFlashFileStreaming(file);

    expect(streamed.sliceCount).toBe(1);
    expect(streamed.md5Hex).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(streamed.sha1Hex).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(streamed.sha1StateV.map(hex)).toEqual([
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    ]);
  });

  it('exact 1 MiB omits the extra un-finalized last-slice state video sha1Blocks keeps', async () => {
    const data = det(MB);
    const file = await writeBin('exact-1m.bin', data);
    const flash = await hashFlashFileStreaming(file);
    const video = await hashFileStreaming(file);
    const overall = nodeSha1Hex(data);
    const refState = computeSha1StateV(data, 1, MB);

    expect(flash.sliceCount).toBe(1);
    expect(flash.sha1StateV).toHaveLength(1);
    expect(hex(flash.sha1StateV[0]!)).toBe(overall);
    expect(hex(flash.sha1StateV[0]!)).toBe(hex(refState[0]!));
    expect(video.sha1Blocks).toHaveLength(2);
    expect(hex(flash.sha1StateV[0]!)).toBe(hex(video.sha1Blocks[1]!));
    expect(hex(flash.sha1StateV[0]!)).not.toBe(hex(video.sha1Blocks[0]!));
    expect(flash.md5Hex).toBe(nodeMd5Hex(data));
  });

  it('1 MiB + 1: first state is the un-finalized 1 MiB snapshot', async () => {
    const data = det(MB + 1);
    const file = await writeBin('1m-plus.bin', data);
    const flash = await hashFlashFileStreaming(file);
    const manual = new Sha1Stream();
    manual.update(data.subarray(0, MB));
    const refState = computeSha1StateV(data, 2, MB);

    expect(flash.sliceCount).toBe(2);
    expect(flash.sha1StateV).toHaveLength(2);
    expect(hex(flash.sha1StateV[0]!)).toBe(hex(manual.hash(true)));
    expect(hex(flash.sha1StateV[0]!)).not.toBe(nodeSha1Hex(data.subarray(0, MB)));
    expect(hex(flash.sha1StateV[1]!)).toBe(nodeSha1Hex(data));
    expect(flash.sha1StateV.map(hex)).toEqual(refState.map(hex));
  });

  it('exact 2 MiB: flash has 2 states, video sha1Blocks has 3', async () => {
    const data = det(2 * MB);
    const file = await writeBin('exact-2m.bin', data);
    const flash = await hashFlashFileStreaming(file);
    const video = await hashFileStreaming(file);

    expect(flash.sliceCount).toBe(2);
    expect(flash.sha1StateV).toHaveLength(2);
    expect(video.sha1Blocks).toHaveLength(3);
    expect(hex(flash.sha1StateV[0]!)).toBe(hex(video.sha1Blocks[0]!));
    expect(hex(flash.sha1StateV[1]!)).toBe(hex(video.sha1Blocks[2]!));
    expect(hex(flash.sha1StateV[1]!)).toBe(nodeSha1Hex(data));
    expect(flash.sha1StateV.map(hex)).toEqual(computeSha1StateV(data, 2, MB).map(hex));
    expect(flash.md5Hex).toBe(computeHashes(data).md5Hex);
  });

  it('2 MiB + 12345 Sha1StateV matches computeSha1StateV and Node overall sha1', async () => {
    const data = det(2 * MB + 12345);
    const file = await writeBin('golden-2m.bin', data);
    const flash = await hashFlashFileStreaming(file);

    expect(flash.sliceCount).toBe(3);
    expect(flash.sha1Hex).toBe('dd9cfd4648ab460260afa820c98bfec1b17655d4');
    expect(hex(flash.sha1StateV[2]!)).toBe('dd9cfd4648ab460260afa820c98bfec1b17655d4');
    expect(hex(flash.sha1StateV[0]!)).toBe('ab9a20fd6c98fc1f8f0c985cd552ff14c6feacfd');
    expect(hex(flash.sha1StateV[1]!)).toBe('2ccc5923b75f46ebd8ccb78e8c413c18025178b9');
    expect(flash.sha1StateV.map(hex)).toEqual(computeSha1StateV(data, 3, MB).map(hex));
  });

  it('rejects a missing path from stat before hashing', async () => {
    await expect(hashFlashFileStreaming(join(dir, 'no-such.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
