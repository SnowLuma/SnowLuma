// 流式 SHA1 计算器，支持输出中间 state（不 finalize）。
// 闪传 sliceupload 的 f107.f6 (Sha1StateV) 需要每片对应的累积 SHA1 中间 state，
// Node.js 内置 crypto 只能算完整 digest，这里自行实现 transform 以暴露中间 state。

import { createHash } from 'node:crypto';

const SHA1_BLOCK_SIZE = 64;
const SHA1_DIGEST_SIZE = 20;

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

export class Sha1Stream {
  private readonly state = new Uint32Array(5);
  private readonly count = new Uint32Array(2);  // [low, high] bit count
  private readonly buffer = new Uint8Array(SHA1_BLOCK_SIZE);

  constructor() { this.reset(); }

  reset(): void {
    this.state[0] = 0x67452301;
    this.state[1] = 0xEFCDAB89;
    this.state[2] = 0x98BADCFE;
    this.state[3] = 0x10325476;
    this.state[4] = 0xC3D2E1F0;
    this.count[0] = 0;
    this.count[1] = 0;
  }

  private transform(data: Uint8Array, offset: number): void {
    const w = new Uint32Array(80);
    const dv = new DataView(data.buffer, data.byteOffset + offset, 64);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(i * 4, false);  // big-endian
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = this.state[0], b = this.state[1], c = this.state[2], d = this.state[3], e = this.state[4];
    for (let i = 0; i < 80; i++) {
      let temp: number;
      if (i < 20) temp = ((b & c) | (~b & d)) + 0x5A827999;
      else if (i < 40) temp = (b ^ c ^ d) + 0x6ED9EBA1;
      else if (i < 60) temp = ((b & c) | (b & d) | (c & d)) + 0x8F1BBCDC;
      else temp = (b ^ c ^ d) + 0xCA62C1D6;
      temp = (temp + rotl(a, 5) + e + w[i]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = temp;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
  }

  update(data: Uint8Array): void {
    const len = data.length;
    let index = (this.count[0] >>> 3) & 0x3F;
    this.count[0] = (this.count[0] + (len << 3)) >>> 0;
    if (this.count[0] < (len << 3)) this.count[1] = (this.count[1] + 1) >>> 0;
    this.count[1] = (this.count[1] + (len >>> 29)) >>> 0;

    let partLen = SHA1_BLOCK_SIZE - index;
    let i = 0;
    if (len >= partLen) {
      this.buffer.set(data.subarray(0, partLen), index);
      this.transform(this.buffer, 0);
      i = partLen;
      while (i + SHA1_BLOCK_SIZE <= len) {
        this.transform(data, i);
        i += SHA1_BLOCK_SIZE;
      }
      index = 0;
    }
    this.buffer.set(data.subarray(i), index);
  }

  /** 输出当前 state（20B）。littleEndian=true 小端，false 大端。不 finalize。 */
  hash(littleEndian: boolean): Uint8Array {
    const digest = new Uint8Array(SHA1_DIGEST_SIZE);
    const dv = new DataView(digest.buffer);
    for (let i = 0; i < 5; i++) {
      if (littleEndian) dv.setUint32(i * 4, this.state[i], true);
      else dv.setUint32(i * 4, this.state[i], false);
    }
    return digest;
  }
}

/**
 * 计算闪传 sliceupload 的 Sha1StateV（累积 SHA1 state list）。
 * states[i] = SHA1 中间 state（从初始 state 处理 file[0:(i+1)*sliceSize] 后，无 finalize，小端 20B）。
 * 最后一片 states[last] = 标准整文件 SHA1（有 finalize）。
 *
 * 用单个 Sha1Stream 增量 update：每片只喂新增的 sliceSize 字节再快照，O(n)。
 * （sliceSize=1MB 是 SHA1 块大小 64B 的整数倍，增量 update 不会残留半块。）
 */
export function computeSha1StateV(bytes: Uint8Array, sliceCount: number, sliceSize: number): Uint8Array[] {
  const states: Uint8Array[] = [];
  const sha1 = new Sha1Stream();
  for (let i = 0; i < sliceCount; i++) {
    const start = i * sliceSize;
    const end = Math.min(start + sliceSize, bytes.length);
    sha1.update(bytes.subarray(start, end));
    if (i !== sliceCount - 1) {
      states.push(sha1.hash(true));  // 小端中间 state，不 finalize
    } else {
      // 最后一片：标准整文件 SHA1（有 finalize）
      states.push(new Uint8Array(createHash('sha1').update(Buffer.from(bytes)).digest()));
    }
  }
  return states;
}
