import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { computeVideoSha1Blocks } from '../../src/highway/video-upload';

// Deterministic input generator (matches the golden-capture script).
function det(len: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (i * 31 + 7) & 0xFF;
  return b;
}
const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const nodeSha1 = (b: Uint8Array): string => createHash('sha1').update(Buffer.from(b)).digest('hex');

describe('computeVideoSha1Blocks', () => {
  // GOLDEN: captured from the previous hand-rolled Sha1StreamState implementation
  // before the F3 rewrite (Sha1Stream + Node crypto), so this locks the rewrite
  // byte-identical for the block states AND the overall digest.
  it('reproduces the pre-refactor golden 1MB-block states + overall sha1', () => {
    const input = det(2 * 1024 * 1024 + 12345); // 2 full 1MB blocks + a partial tail
    expect(computeVideoSha1Blocks(input).map(hex)).toEqual([
      'ab9a20fd6c98fc1f8f0c985cd552ff14c6feacfd', // intermediate un-finalized state @1MB (little-endian)
      '2ccc5923b75f46ebd8ccb78e8c413c18025178b9', // intermediate un-finalized state @2MB
      'dd9cfd4648ab460260afa820c98bfec1b17655d4', // overall (finalized)
    ]);
  });

  it('the final block equals the standard full-file SHA1', () => {
    const input = det(2 * 1024 * 1024 + 12345);
    const blocks = computeVideoSha1Blocks(input);
    expect(hex(blocks[blocks.length - 1]!)).toBe(nodeSha1(input));
  });

  it('a file shorter than 1MB yields just the overall sha1', () => {
    const input = det(1000);
    const blocks = computeVideoSha1Blocks(input);
    expect(blocks).toHaveLength(1);
    expect(hex(blocks[0]!)).toBe(nodeSha1(input));
  });

  it('a file that is an exact 1MB multiple emits the boundary state then the overall', () => {
    const input = det(1024 * 1024);
    const blocks = computeVideoSha1Blocks(input);
    expect(blocks).toHaveLength(2);
    expect(hex(blocks[1]!)).toBe(nodeSha1(input)); // last is the finalized overall
  });
});
