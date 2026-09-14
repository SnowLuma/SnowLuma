// Streaming file hasher for the disk-backed upload path (#stream-upload).
//
// The buffered path reads the whole file into RAM and calls
// `computeHashes(bytes)` + `computeVideoSha1Blocks(bytes)` (+ a head-md5 for
// offline files). This does the same in ONE sequential pass over the file,
// 1 MiB at a time, so a multi-GiB upload never buffers more than a chunk.
//
// It MUST be byte-for-byte identical to the buffered helpers — verified by
// `tests/highway/hash-file.test.ts` against `computeHashes` /
// `computeVideoSha1Blocks` / `computeMd5(head)` over the same bytes.

import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import { FileChunkSource } from './highway-client';
import { Sha1Stream } from './sha1-stream';

// Must match video-upload.ts's SHA1_STREAM_BLOCK_SIZE: the Highway video
// "block sha1" snapshots the running SHA1 state at every 1 MiB boundary.
const SHA1_STREAM_BLOCK_SIZE = 1024 * 1024;

export interface StreamedFileHashes {
  md5: Uint8Array;
  sha1: Uint8Array;
  md5Hex: string;
  sha1Hex: string;
  /** Per-1 MiB intermediate SHA1 states (little-endian, un-finalized) plus a
   *  final entry that is the finalized whole-file SHA1 — the exact shape
   *  `computeVideoSha1Blocks` returns. Only meaningful for video; file uploads
   *  ignore it. */
  sha1Blocks: Uint8Array[];
  /** md5 of the first `headLimit` bytes — the offline-file `md510MCheckSum`.
   *  Present only when `headLimit` was passed. */
  headMd5?: Uint8Array;
}

/**
 * Hash a file on disk in a single streaming pass. Equivalent to
 * `computeHashes` + `computeVideoSha1Blocks` (+ `computeMd5(bytes[0:headLimit])`
 * when `headLimit` is given) over the file's bytes, without buffering the file.
 */
export async function hashFileStreaming(
  filePath: string,
  opts?: { headLimit?: number },
): Promise<StreamedFileHashes> {
  const { size } = await fsp.stat(filePath);
  const src = await FileChunkSource.open(filePath, size);
  try {
    const md5 = createHash('md5');
    const sha1 = createHash('sha1');
    const headLimit = opts?.headLimit;
    const headMd5 = headLimit !== undefined ? createHash('md5') : null;
    let headRemaining = headLimit ?? 0;

    // Running SHA1 state fed only full 1 MiB chunks, snapshotted at each 1 MiB
    // boundary — mirrors computeVideoSha1Blocks (which feeds 64-byte blocks and
    // snapshots at 1 MiB; identical result since 1 MiB is a multiple of 64 and
    // Sha1Stream buffers internally). The sub-1 MiB tail is never snapshotted,
    // so it need not be fed to the block-sha1 at all.
    const blockSha1 = new Sha1Stream();
    const sha1Blocks: Uint8Array[] = [];

    let offset = 0;
    while (offset < size) {
      const len = Math.min(SHA1_STREAM_BLOCK_SIZE, size - offset);
      const chunk = await src.read(offset, len);
      md5.update(chunk);
      sha1.update(chunk);
      if (headMd5 && headRemaining > 0) {
        const take = Math.min(headRemaining, chunk.length);
        headMd5.update(chunk.subarray(0, take));
        headRemaining -= take;
      }
      if (len === SHA1_STREAM_BLOCK_SIZE) {
        blockSha1.update(chunk);
        sha1Blocks.push(blockSha1.hash(true)); // little-endian intermediate state
      }
      offset += len;
    }

    const sha1Digest = sha1.digest();
    // Final entry: the finalized whole-file SHA1 — the last element
    // computeVideoSha1Blocks pushes.
    sha1Blocks.push(new Uint8Array(sha1Digest));
    const md5Digest = md5.digest();

    return {
      md5: new Uint8Array(md5Digest),
      sha1: new Uint8Array(sha1Digest),
      md5Hex: md5Digest.toString('hex'),
      sha1Hex: sha1Digest.toString('hex'),
      sha1Blocks,
      headMd5: headMd5 ? new Uint8Array(headMd5.digest()) : undefined,
    };
  } finally {
    await src.close();
  }
}

export interface StreamedFlashHashes {
  md5: Uint8Array;
  sha1: Uint8Array;
  md5Hex: string;
  sha1Hex: string;
  /** Flash sliceupload Sha1StateV — un-finalized little-endian state after
   *  every full 1 MiB slice except the last; the last entry is the finalized
   *  whole-file SHA1. Same shape as `computeSha1StateV`, not `sha1Blocks`. */
  sha1StateV: Uint8Array[];
  sliceCount: number;
}

/**
 * Streaming hash for flash-transfer sliceupload. Equivalent to
 * `computeHashes` + `computeSha1StateV(bytes, ceil(size/1MiB), 1MiB)`
 * without buffering the file.
 *
 * Do not substitute `hashFileStreaming().sha1Blocks`: when
 * `size % 1 MiB === 0` that list has an extra un-finalized last-slice
 * state that flash's Sha1StateV must not carry.
 */
export async function hashFlashFileStreaming(filePath: string): Promise<StreamedFlashHashes> {
  const { size } = await fsp.stat(filePath);
  const sliceCount = Math.ceil(size / SHA1_STREAM_BLOCK_SIZE);
  const src = await FileChunkSource.open(filePath, size);
  try {
    const md5 = createHash('md5');
    const sha1 = createHash('sha1');
    const blockSha1 = new Sha1Stream();
    const sha1StateV: Uint8Array[] = [];

    let offset = 0;
    let sliceIndex = 0;
    while (offset < size) {
      const len = Math.min(SHA1_STREAM_BLOCK_SIZE, size - offset);
      const chunk = await src.read(offset, len);
      md5.update(chunk);
      sha1.update(chunk);
      blockSha1.update(chunk);
      if (sliceIndex !== sliceCount - 1) {
        sha1StateV.push(blockSha1.hash(true));
      }
      offset += len;
      sliceIndex += 1;
    }

    const sha1Digest = sha1.digest();
    if (sliceCount > 0) {
      sha1StateV.push(new Uint8Array(sha1Digest));
    }
    const md5Digest = md5.digest();

    return {
      md5: new Uint8Array(md5Digest),
      sha1: new Uint8Array(sha1Digest),
      md5Hex: md5Digest.toString('hex'),
      sha1Hex: sha1Digest.toString('hex'),
      sha1StateV,
      sliceCount,
    };
  } finally {
    await src.close();
  }
}
