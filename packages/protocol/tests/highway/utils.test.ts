import { describe, it, expect } from 'vitest';
import { detectImageFormat } from '@snowluma/protocol/highway/utils';

// Regression coverage for detectImageFormat (was previously untested). The
// header-parsing is all hand-rolled byte math, so each format's offset AND
// endianness is pinned here. The VP8X cases exist because that branch read the
// canvas width/height big-endian when the WebP spec stores them 24-bit
// little-endian (issue #112: a 1920×1080 image came back as 8324865×3605505,
// cropping the QQ thumbnail). VP8 / VP8L were already little-endian.

// ── little-endian byte writers (match how the formats store dimensions) ──
function le16(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
function le24(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
}
function le32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}
function be16(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff];
}
function be32(v: number): number[] {
  return [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}
/** Build a buffer from segments placed at explicit offsets; gaps are 0. */
function buf(len: number, ...segs: Array<[number, number[]]>): Uint8Array {
  const b = new Uint8Array(len);
  for (const [off, bytes] of segs) b.set(bytes, off);
  return b;
}

describe('detectImageFormat', () => {
  it('PNG — IHDR width/height (big-endian @16/@20) → 1001', () => {
    const b = buf(24, [0, [0x89, 0x50, 0x4e, 0x47]], [16, be32(800)], [20, be32(600)]);
    expect(detectImageFormat(b)).toEqual({ format: 1001, width: 800, height: 600 });
  });

  it('GIF — logical screen width/height (little-endian @6/@8) → 2000', () => {
    const b = buf(10, [0, ascii('GIF89a')], [6, le16(320)], [8, le16(240)]);
    expect(detectImageFormat(b)).toEqual({ format: 2000, width: 320, height: 240 });
    // GIF87a header variant is also accepted.
    const b87 = buf(10, [0, ascii('GIF87a')], [6, le16(48)], [8, le16(16)]);
    expect(detectImageFormat(b87)).toEqual({ format: 2000, width: 48, height: 16 });
  });

  it('BMP — DIB width/height (little-endian @18/@22) → 1005', () => {
    const b = buf(26, [0, ascii('BM')], [18, le32(1024)], [22, le32(768)]);
    expect(detectImageFormat(b)).toEqual({ format: 1005, width: 1024, height: 768 });
  });

  it('WebP VP8 (lossy) — little-endian @26/@28 → 1002', () => {
    const b = buf(32, [0, ascii('RIFF')], [8, ascii('WEBP')], [12, ascii('VP8 ')], [26, le16(640)], [28, le16(480)]);
    expect(detectImageFormat(b)).toEqual({ format: 1002, width: 640, height: 480 });
  });

  it('WebP VP8L (lossless) — 14-bit fields packed in LE32 @21 → 1002', () => {
    // width-1 in bits[0..13], height-1 in bits[14..27].
    const bits = (100 - 1) | ((200 - 1) << 14);
    const b = buf(32, [0, ascii('RIFF')], [8, ascii('WEBP')], [12, ascii('VP8L')], [21, le32(bits >>> 0)]);
    expect(detectImageFormat(b)).toEqual({ format: 1002, width: 100, height: 200 });
  });

  it('WebP VP8X (extended) — canvas width/height are 24-bit LITTLE-endian +1 @24/@27 → 1002 (issue #112)', () => {
    const b = buf(34, [0, ascii('RIFF')], [8, ascii('WEBP')], [12, ascii('VP8X')], [24, le24(1920 - 1)], [27, le24(1080 - 1)]);
    expect(detectImageFormat(b)).toEqual({ format: 1002, width: 1920, height: 1080 });
  });

  it('WebP VP8X — asymmetric dims pin byte order (BE misread would give huge/swapped values)', () => {
    // 256×1: width-1=255 → LE bytes [ff,00,00]; a BE read of those = 16711680.
    // height-1=0 → [00,00,00]. Distinct w≠h also catches an offset swap.
    const b = buf(34, [0, ascii('RIFF')], [8, ascii('WEBP')], [12, ascii('VP8X')], [24, le24(256 - 1)], [27, le24(1 - 1)]);
    expect(detectImageFormat(b)).toEqual({ format: 1002, width: 256, height: 1 });
  });

  it('WebP VP8X — exact bytes from issue #112 decode to 1920×1080, not 8324865×3605505', () => {
    // The reported broken values came from these literal canvas bytes.
    const b = buf(34, [0, ascii('RIFF')], [8, ascii('WEBP')], [12, ascii('VP8X')],
      [24, [0x7f, 0x07, 0x00]], [27, [0x37, 0x04, 0x00]]);
    expect(detectImageFormat(b)).toEqual({ format: 1002, width: 1920, height: 1080 });
  });

  it('JPEG — dimensions from the SOF0 segment (big-endian, height before width) → 1000', () => {
    // FFD8 SOI, then SOF0 (FFC0) segment: len(BE16)=17, precision, height@+5, width@+7.
    // Buffer must hold the whole declared 17-byte segment (offset 2..20) or the
    // parser's bounds-check bails before reading — hence length 24, not 20.
    const b = buf(24,
      [0, [0xff, 0xd8]],
      [2, [0xff, 0xc0]], [4, be16(17)], [6, [8]], [7, be16(720)], [9, be16(1280)]);
    expect(detectImageFormat(b)).toEqual({ format: 1000, width: 1280, height: 720 });
  });

  it('JPEG — skips a DHT (0xFFC4) segment before SOF0 (must not misread Huffman bytes)', () => {
    // SOI, DHT(FFC4) len=4 (2 payload bytes), then SOF0 with real 640×480.
    const b = buf(28,
      [0, [0xff, 0xd8]],
      [2, [0xff, 0xc4]], [4, be16(4)], [6, [0xde, 0xad]],
      [8, [0xff, 0xc0]], [10, be16(17)], [12, [8]], [13, be16(480)], [15, be16(640)]);
    expect(detectImageFormat(b)).toEqual({ format: 1000, width: 640, height: 480 });
  });

  it('unknown bytes fall back to {1000, 0, 0} without throwing', () => {
    expect(detectImageFormat(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({ format: 1000, width: 0, height: 0 });
  });

  it('a truncated WebP header (<30 bytes) does not crash and falls through', () => {
    const b = buf(20, [0, ascii('RIFF')], [8, ascii('WEBP')], [12, ascii('VP8X')]);
    expect(detectImageFormat(b)).toEqual({ format: 1000, width: 0, height: 0 });
  });
});
