import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Sha1Stream, computeSha1StateV } from '@snowluma/protocol/highway/sha1-stream';

// SHA1 标准填充：msg + 0x80 + 0x00...(k 个) + 8 字节大端 bit 长度，总长为 64 倍数。
// 用于把任意输入变成「已 finalize」的完整 block 序列——这样 Sha1Stream 对它逐 block
// transform 后取大端 state，应当等于 Node crypto 对原始 msg 的 digest。
function sha1Pad(msg: Uint8Array): Uint8Array {
  const msgLen = msg.length;
  const k = (56 - ((msgLen + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(msgLen + 1 + k + 8);
  padded.set(msg, 0);
  padded[msgLen] = 0x80;
  const view = new DataView(padded.buffer, padded.byteOffset + padded.byteLength - 8, 8);
  view.setBigUint64(0, BigInt(msgLen) * 8n, false); // 大端 bit 长度
  return padded;
}

// padding oracle 的核心：Node crypto 的 SHA1 digest 内部就是对 padding 后的输入逐 block
// transform、取最终 state 的大端表示。Sha1Stream 自行实现 transform 且不 finalize，
// 因此对「已 padding 的输入」transform 后大端输出必须等于 digest。Node crypto 走
// OpenSSL，与本实现完全独立，是验证 transform 正确性的可靠参照。
function expectSha1StreamMatchesCrypto(msg: Uint8Array): void {
  const expected = createHash('sha1').update(Buffer.from(msg)).digest();
  const stream = new Sha1Stream();
  stream.update(sha1Pad(msg));
  const bigEndian = stream.hash(false);
  expect(Buffer.from(bigEndian).equals(expected)).toBe(true);
}

describe('Sha1Stream transform (padding oracle vs Node crypto)', () => {
  it('matches for empty input (single padded block)', () => {
    expectSha1StreamMatchesCrypto(Buffer.alloc(0));
  });

  it('matches for "abc" (single padded block)', () => {
    expectSha1StreamMatchesCrypto(Buffer.from('abc', 'utf8'));
  });

  it('matches across the 56-byte boundary (forces a second padded block)', () => {
    // 56 字节：0x80 后只剩 0 字节给 zeros 不够放 8 字节长度，padding 溢出到第二块。
    expectSha1StreamMatchesCrypto(Buffer.alloc(56, 0x41));
  });

  it('matches for exactly one block (64 bytes → two padded blocks)', () => {
    expectSha1StreamMatchesCrypto(Buffer.alloc(64, 0x42));
  });

  it('matches for multi-block input (200 bytes → four padded blocks)', () => {
    expectSha1StreamMatchesCrypto(Buffer.alloc(200, 0x43));
  });

  it('matches for pseudo-random multi-block input', () => {
    const data = Buffer.alloc(313, 0);
    for (let i = 0; i < data.length; i++) data[i] = (i * 1103515245 + 12345) & 0xff;
    expectSha1StreamMatchesCrypto(data);
  });
});

describe('Sha1Stream update chunk-equivalence', () => {
  // update 内部维护 64 字节 buffer + 128 位 bit 计数；分块喂入必须与一次性喂入
  // 产生相同的内部 state。切分点覆盖 block 边界附近以暴露 buffer/count 管理 bug。
  it('two-chunk split at various boundaries yields the same state as one update', () => {
    const data = Buffer.alloc(200, 0x44);
    const full = new Sha1Stream();
    full.update(data);
    const fullHash = Buffer.from(full.hash(true));
    for (const split of [0, 1, 32, 63, 64, 65, 127, 128, 129, 199]) {
      const s = new Sha1Stream();
      s.update(data.subarray(0, split));
      s.update(data.subarray(split));
      expect(Buffer.from(s.hash(true)).equals(fullHash)).toBe(true);
    }
  });

  it('three-chunk split yields the same state as one update', () => {
    const data = Buffer.alloc(300, 0x45);
    const full = new Sha1Stream();
    full.update(data);
    const fullHash = Buffer.from(full.hash(true));
    const s = new Sha1Stream();
    s.update(data.subarray(0, 100));
    s.update(data.subarray(100, 200));
    s.update(data.subarray(200));
    expect(Buffer.from(s.hash(true)).equals(fullHash)).toBe(true);
  });

  it('empty updates do not change the state', () => {
    const data = Buffer.alloc(130, 0x46);
    const full = new Sha1Stream();
    full.update(data);
    const fullHash = Buffer.from(full.hash(true));
    const s = new Sha1Stream();
    s.update(Buffer.alloc(0));
    s.update(data);
    s.update(Buffer.alloc(0));
    expect(Buffer.from(s.hash(true)).equals(fullHash)).toBe(true);
  });
});

describe('Sha1Stream hash endianness', () => {
  // hash(true) 小端与 hash(false) 大端是同一组 5 个 state word 的不同字节序表示。
  // 结合上面的 padding oracle（大端 == digest），即可间接确认小端中间 state 的值。
  it('little-endian is the per-word byte-swap of big-endian', () => {
    const s = new Sha1Stream();
    s.update(Buffer.alloc(64, 0x47));
    const le = Buffer.from(s.hash(true));
    const be = Buffer.from(s.hash(false));
    expect(le.length).toBe(20);
    for (let i = 0; i < 5; i++) {
      expect(le.readUInt32LE(i * 4)).toBe(be.readUInt32BE(i * 4));
    }
  });

  it('reset restores the initial SHA1 state', () => {
    const s = new Sha1Stream();
    s.update(Buffer.alloc(200, 0x48));
    s.reset();
    const initial = Buffer.from(s.hash(false));
    const expected = Buffer.from([
      0x67, 0x45, 0x23, 0x01, 0xef, 0xcd, 0xab, 0x89,
      0x98, 0xba, 0xdc, 0xfe, 0x10, 0x32, 0x54, 0x76,
      0xc3, 0xd2, 0xe1, 0xf0,
    ]);
    expect(initial.equals(expected)).toBe(true);
  });
});

describe('computeSha1StateV', () => {
  const SLICE = 1024 * 1024; // 1 MB，与上传链路一致，且是 64 的倍数

  it('returns one 20-byte state per slice', () => {
    const data = Buffer.alloc(SLICE + 100, 0x49); // 2 片
    const states = computeSha1StateV(data, 2, SLICE);
    expect(states.length).toBe(2);
    for (const st of states) expect(st.length).toBe(20);
  });

  // 末片定义为「标准整文件 SHA1（有 finalize/padding）」，直接对齐 Node crypto。
  it('last slice equals the standard full-file SHA1 digest', () => {
    const data = Buffer.alloc(SLICE + 100, 0x4a);
    const states = computeSha1StateV(data, 2, SLICE);
    const expected = createHash('sha1').update(data).digest();
    expect(Buffer.from(states[1]).equals(expected)).toBe(true);
  });

  it('last slice equals full-file SHA1 for a three-slice file', () => {
    const data = Buffer.alloc(SLICE * 2 + 1, 0x4b);
    const states = computeSha1StateV(data, 3, SLICE);
    expect(Buffer.from(states[2]).equals(createHash('sha1').update(data).digest())).toBe(true);
  });

  // 非末片是「累积 SHA1 中间 state（不 finalize，小端）」。若误用标准 finalize
  // 计算，会得到 file[0:slice] 的完整 digest，与本实现必然不等——以此锁定
  // 「中间 state 而非独立片 digest」的语义。
  it('non-last slice is NOT the finalized digest of the prefix', () => {
    const data = Buffer.alloc(SLICE + 100, 0x4c);
    const states = computeSha1StateV(data, 2, SLICE);
    const prefixDigest = createHash('sha1').update(data.subarray(0, SLICE)).digest();
    expect(Buffer.from(states[0]).equals(prefixDigest)).toBe(false);
  });

  // 非末片中间 state 的正确性来自 transform（padding oracle 已验）与 update
  // 分块等价（已验）。这里再做一次直接对照：computeSha1StateV 对首片的处理
  // 等价于手动 reset + update(prefix) + 小端输出。
  it('non-last slice equals manual Sha1Stream reset+update of the prefix', () => {
    const data = Buffer.alloc(SLICE + 100, 0x4d);
    const states = computeSha1StateV(data, 2, SLICE);
    const manual = new Sha1Stream();
    manual.update(data.subarray(0, SLICE));
    expect(Buffer.from(states[0]).equals(Buffer.from(manual.hash(true)))).toBe(true);
  });

  // 单片文件只有末片，直接是整文件 digest。
  it('single-slice file has only the finalized digest', () => {
    const data = Buffer.alloc(100, 0x4e);
    const states = computeSha1StateV(data, 1, SLICE);
    expect(states.length).toBe(1);
    expect(Buffer.from(states[0]).equals(createHash('sha1').update(data).digest())).toBe(true);
  });

  // 中间 state 与「把它当末片算出的 digest」必须不同——这是 sliceupload 服务端
  // 校验「累积 state 而非独立片 digest」的核心区分点。
  it('non-last slice differs from a single-slice digest of the same prefix', () => {
    const data = Buffer.alloc(SLICE + 100, 0x4f);
    const multiFirst = computeSha1StateV(data, 2, SLICE)[0];
    const singleAsLast = computeSha1StateV(data.subarray(0, SLICE), 1, SLICE)[0];
    expect(Buffer.from(multiFirst).equals(Buffer.from(singleAsLast))).toBe(false);
  });
});
