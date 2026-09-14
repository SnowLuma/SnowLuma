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
function __readVarint32(data, offset, end) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset >= end) throw new Error('protobuf truncated uint32 varint');
    const byte = data[offset++];
    if (i === 4 && (byte & 0xf0) !== 0) throw new Error('protobuf uint32 varint overflow');
    value += (byte & 0x7f) * (2 ** (i * 7));
    if ((byte & 0x80) === 0) return [value >>> 0, offset];
  }
  throw new Error('protobuf uint32 varint overflow');
}
function __readVarint64(data, offset, end) {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    if (offset >= end) throw new Error('protobuf truncated uint64 varint');
    const byte = data[offset++];
    if (i === 9 && byte > 1) throw new Error('protobuf uint64 varint overflow');
    value |= BigInt(byte & 0x7f) << BigInt(i * 7);
    if ((byte & 0x80) === 0) return [value, offset];
  }
  throw new Error('protobuf uint64 varint overflow');
}
function __readVarint32Value(data, offset, end) {
  const [value, next] = __readVarint64(data, offset, end);
  // QQ-compatible protobuf runtimes consume a complete, well-formed uint32
  // value varint and retain its low 32 bits. Keep tags and lengths on
  // __readVarint32 so malformed framing still fails before it affects bounds.
  return [Number(BigInt.asUintN(32, value)), next];
}
function __skipVarint(data, offset, end) {
  for (let i = 0; i < 10; i++) {
    if (offset >= end) throw new Error('protobuf truncated varint');
    const byte = data[offset++];
    if (i === 9 && byte > 1) throw new Error('protobuf varint overflow');
    if ((byte & 0x80) === 0) return offset;
  }
  throw new Error('protobuf varint overflow');
}
function __checkedEnd(offset, length, end) {
  if (length > end - offset) throw new Error('protobuf length-delimited field exceeds parent bounds');
  return offset + length;
}
function __skipUnknownField(data, offset, end, wireType, fieldNumber, depth = 0) {
  if (depth > 64) throw new Error('protobuf group nesting exceeds 64');
  if (wireType === 0) return __skipVarint(data, offset, end);
  if (wireType === 1) {
    if (end - offset < 8) throw new Error('protobuf truncated fixed64 field');
    return offset + 8;
  }
  if (wireType === 2) {
    const [length, next] = __readVarint32(data, offset, end);
    return __checkedEnd(next, length, end);
  }
  if (wireType === 3) {
    while (offset < end) {
      const [tag, next] = __readVarint32(data, offset, end);
      offset = next;
      const nestedField = tag >>> 3;
      const nestedWire = tag & 0x7;
      if (nestedField === 0) throw new Error('protobuf field number 0 is invalid');
      if (nestedWire === 4) {
        if (nestedField !== fieldNumber) throw new Error('protobuf mismatched end-group tag');
        return offset;
      }
      offset = __skipUnknownField(data, offset, end, nestedWire, nestedField, depth + 1);
    }
    throw new Error('protobuf unterminated group');
  }
  if (wireType === 4) throw new Error('protobuf unexpected end-group tag');
  if (wireType === 5) {
    if (end - offset < 4) throw new Error('protobuf truncated fixed32 field');
    return offset + 4;
  }
  throw new Error('protobuf invalid wire type ' + wireType);
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
