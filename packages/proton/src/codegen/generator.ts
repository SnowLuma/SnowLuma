import type { MessageRegistry } from '../ast/types.js';
import { generateEncoder } from './encoder.js';
import { generateDecoder } from './decoder.js';

/** Shared preamble: UTF-8 string helpers plus TextDecoder for decode. */
const CODEGEN_PREAMBLE = `const __td = new TextDecoder();
const __scratch = new DataView(new ArrayBuffer(8));
function __utf8Len(value) {
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      length++;
      continue;
    }
    if (code < 0x800) {
      length += 2;
      continue;
    }
    if ((code & 0xfc00) === 0xd800) {
      if (i + 1 < value.length) {
        const next = value.charCodeAt(i + 1);
        if ((next & 0xfc00) === 0xdc00) {
          length += 4;
          i++;
          continue;
        }
      }
      length += 3;
      continue;
    }
    if ((code & 0xfc00) === 0xdc00) {
      length += 3;
      continue;
    }
    length += 3;
  }
  return length;
}
function __utf8Write(buf, offset, value) {
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code < 0x80) {
      buf[offset++] = code;
      continue;
    }
    if (code < 0x800) {
      buf[offset++] = 0xc0 | (code >> 6);
      buf[offset++] = 0x80 | (code & 0x3f);
      continue;
    }
    if ((code & 0xfc00) === 0xd800) {
      if (i + 1 < value.length) {
        const next = value.charCodeAt(i + 1);
        if ((next & 0xfc00) === 0xdc00) {
          const point = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
          buf[offset++] = 0xf0 | (point >> 18);
          buf[offset++] = 0x80 | ((point >> 12) & 0x3f);
          buf[offset++] = 0x80 | ((point >> 6) & 0x3f);
          buf[offset++] = 0x80 | (point & 0x3f);
          i++;
          continue;
        }
      }
      code = 0xfffd;
    } else if ((code & 0xfc00) === 0xdc00) {
      code = 0xfffd;
    }
    buf[offset++] = 0xe0 | (code >> 12);
    buf[offset++] = 0x80 | ((code >> 6) & 0x3f);
    buf[offset++] = 0x80 | (code & 0x3f);
  }
  return offset;
}
function __varint64Size(value) {
  let size = 1;
  while (value > 0x7fn) {
    value >>= 7n;
    size++;
  }
  return size;
}
function __writeVarint64(buf, offset, value) {
  while (value > 0x7fn) {
    buf[offset++] = Number((value & 0x7fn) | 0x80n);
    value >>= 7n;
  }
  buf[offset++] = Number(value);
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
  buf[offset++] = Number(value & 0xffn);
  buf[offset++] = Number((value >> 8n) & 0xffn);
  buf[offset++] = Number((value >> 16n) & 0xffn);
  buf[offset++] = Number((value >> 24n) & 0xffn);
  buf[offset++] = Number((value >> 32n) & 0xffn);
  buf[offset++] = Number((value >> 40n) & 0xffn);
  buf[offset++] = Number((value >> 48n) & 0xffn);
  buf[offset++] = Number((value >> 56n) & 0xffn);
  return offset;
}
function __readFixed64(data, offset) {
  return BigInt(data[offset])
    | (BigInt(data[offset + 1]) << 8n)
    | (BigInt(data[offset + 2]) << 16n)
    | (BigInt(data[offset + 3]) << 24n)
    | (BigInt(data[offset + 4]) << 32n)
    | (BigInt(data[offset + 5]) << 40n)
    | (BigInt(data[offset + 6]) << 48n)
    | (BigInt(data[offset + 7]) << 56n);
}`;

/**
 * Generate fully self-contained encode/decode source code.
 * No runtime imports needed — all wire-format logic is inlined.
 */
export function generateCode(registry: MessageRegistry): string {
  if (registry.size === 0) return '';
  const parts: string[] = [CODEGEN_PREAMBLE];
  for (const msg of registry.values()) {
    parts.push(generateEncoder(msg, registry));
    parts.push(generateDecoder(msg, registry));
  }
  return parts.join('\n');
}
