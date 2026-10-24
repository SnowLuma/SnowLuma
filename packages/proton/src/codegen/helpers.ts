import { utf8 } from './utf8.js';
import { unknownFields } from './unknown.js';
import { buffers } from './buffer.js';

const CODEGEN_PREAMBLE = `${utf8}
${buffers}
${unknownFields}
const __scratch = new DataView(new ArrayBuffer(8));
function __varint64Size(value) {
  if (value < 0x80n) return 1;
  const hi = Number(value >> 32n);
  const bits = hi ? 64 - Math.clz32(hi) : 32 - Math.clz32(Number(value));
  return ((bits + 6) / 7) | 0;
}
function __writeVarint64(buf, offset, value) {
  let lo = Number(value & 0xffffffffn) >>> 0;
  let hi = Number(value >> 32n) >>> 0;
  while (hi || lo > 0x7f) {
    buf[offset++] = (lo & 0x7f) | 0x80;
    lo = ((lo >>> 7) | (hi << 25)) >>> 0;
    hi >>>= 7;
  }
  buf[offset++] = lo;
  return offset;
}
function __zigZagEncode64(value) {
  value = BigInt.asIntN(64, value);
  return BigInt.asUintN(64, (value << 1n) ^ (value >> 63n));
}
function __zigZagDecode64(value) {
  return BigInt.asIntN(64, (value >> 1n) ^ -(value & 1n));
}
function __writeFloat32(buf, offset, value) {
  __scratch.setFloat32(0, value, true);
  buf[offset++] = __scratch.getUint8(0);
  buf[offset++] = __scratch.getUint8(1);
  buf[offset++] = __scratch.getUint8(2);
  buf[offset++] = __scratch.getUint8(3);
  return offset;
}
function __readFloat32(data, offset) {
  __scratch.setUint8(0, data[offset]);
  __scratch.setUint8(1, data[offset + 1]);
  __scratch.setUint8(2, data[offset + 2]);
  __scratch.setUint8(3, data[offset + 3]);
  return __scratch.getFloat32(0, true);
}
function __writeFloat64(buf, offset, value) {
  __scratch.setFloat64(0, value, true);
  buf[offset++] = __scratch.getUint8(0);
  buf[offset++] = __scratch.getUint8(1);
  buf[offset++] = __scratch.getUint8(2);
  buf[offset++] = __scratch.getUint8(3);
  buf[offset++] = __scratch.getUint8(4);
  buf[offset++] = __scratch.getUint8(5);
  buf[offset++] = __scratch.getUint8(6);
  buf[offset++] = __scratch.getUint8(7);
  return offset;
}
function __readFloat64(data, offset) {
  __scratch.setUint8(0, data[offset]);
  __scratch.setUint8(1, data[offset + 1]);
  __scratch.setUint8(2, data[offset + 2]);
  __scratch.setUint8(3, data[offset + 3]);
  __scratch.setUint8(4, data[offset + 4]);
  __scratch.setUint8(5, data[offset + 5]);
  __scratch.setUint8(6, data[offset + 6]);
  __scratch.setUint8(7, data[offset + 7]);
  return __scratch.getFloat64(0, true);
}
function __writeFixed64(buf, offset, value) {
  value = BigInt.asUintN(64, value);
  const lo = Number(value & 0xffffffffn), hi = Number(value >> 32n);
  buf[offset++] = lo;
  buf[offset++] = lo >>> 8;
  buf[offset++] = lo >>> 16;
  buf[offset++] = lo >>> 24;
  buf[offset++] = hi;
  buf[offset++] = hi >>> 8;
  buf[offset++] = hi >>> 16;
  buf[offset++] = hi >>> 24;
  return offset;
}
function __readFixed64(data, offset) {
  const lo = (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
  const hi = (data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24)) >>> 0;
  return BigInt(lo) | (BigInt(hi) << 32n);
}`;

export const helpers = new Map<string, string>();
const helperStarts = [...CODEGEN_PREAMBLE.matchAll(/^(?:function|const|let) (__\w+)/gm)];

for (let i = 0; i < helperStarts.length; i++) {
    helpers.set(
        helperStarts[i][1],
        CODEGEN_PREAMBLE.slice(helperStarts[i].index, helperStarts[i + 1]?.index).trim(),
    );
}
