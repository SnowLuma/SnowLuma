export const utf8 = `const __td = new TextDecoder();
const __te = new TextEncoder();
const __nonAscii = /[^\\x00-\\x7f]/;
let __utf8Scratch;
const __tdStrict = new TextDecoder('utf-8', { fatal: true });
function __utf8LenLong(value) {
  const buffer = __utf8Scratch ??= new Uint8Array(4096);
  let length = 0;
  for (;;) {
    const result = __te.encodeInto(value, buffer);
    length += result.written;
    if (result.read === value.length) return length;
    value = value.slice(result.read);
  }
}
function __utf8Len(value) {
  if (value.length >= 32) return __utf8LenLong(value);
  if (value.length >= 8 && value.charCodeAt(0) < 0x80 && !__nonAscii.test(value)) return value.length;
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
function __utf8WriteLong(buf, offset, value) {
  return offset + __te.encodeInto(value, buf.subarray(offset)).written;
}
function __asciiWrite(buf, offset, value) {
  let i = 0;
  for (; i + 7 < value.length; i += 8) {
    buf[offset++] = value.charCodeAt(i);
    buf[offset++] = value.charCodeAt(i + 1);
    buf[offset++] = value.charCodeAt(i + 2);
    buf[offset++] = value.charCodeAt(i + 3);
    buf[offset++] = value.charCodeAt(i + 4);
    buf[offset++] = value.charCodeAt(i + 5);
    buf[offset++] = value.charCodeAt(i + 6);
    buf[offset++] = value.charCodeAt(i + 7);
  }
  for (; i < value.length; i++) buf[offset++] = value.charCodeAt(i);
  return offset;
}
function __utf8ReadLong(data, start, end) {
  const bytes = data.subarray(start, end);
  if (end - start < 128) return __td.decode(bytes);
  try {
    return __tdStrict.decode(bytes);
  } catch {
    return __td.decode(bytes);
  }
}
function __utf8Read(data, start, end) {
  let value = '', offset = start;
  while (offset + 7 < end) {
    const a = data[offset], b = data[offset + 1], c = data[offset + 2], d = data[offset + 3];
    const e = data[offset + 4], f = data[offset + 5], g = data[offset + 6], h = data[offset + 7];
    if ((a | b | c | d | e | f | g | h) & 0x80) break;
    value += String.fromCharCode(a, b, c, d, e, f, g, h);
    offset += 8;
  }
  if (offset + 3 < end) {
    const a = data[offset], b = data[offset + 1], c = data[offset + 2], d = data[offset + 3];
    if (!((a | b | c | d) & 0x80)) {
      value += String.fromCharCode(a, b, c, d);
      offset += 4;
    }
  }
  while (offset < end) {
    const a = data[offset++];
    if (a < 0x80) {
      value += String.fromCharCode(a);
    } else if (a >= 0xc2 && a < 0xe0 && offset < end) {
      const b = data[offset++];
      if ((b & 0xc0) !== 0x80) return __td.decode(data.subarray(start, end));
      value += String.fromCharCode(((a & 0x1f) << 6) | (b & 0x3f));
    } else if (a >= 0xe0 && a < 0xf0 && offset + 1 < end) {
      const b = data[offset++], c = data[offset++];
      if ((b & 0xc0) !== 0x80 || (c & 0xc0) !== 0x80 ||
          (a === 0xe0 && b < 0xa0) || (a === 0xed && b >= 0xa0)) {
        return __td.decode(data.subarray(start, end));
      }
      const code = ((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f);
      // Match TextDecoder's handling of a leading BOM.
      if (code !== 0xfeff || offset !== start + 3) value += String.fromCharCode(code);
    } else if (a >= 0xf0 && a < 0xf5 && offset + 2 < end) {
      const b = data[offset++], c = data[offset++], d = data[offset++];
      if ((b & 0xc0) !== 0x80 || (c & 0xc0) !== 0x80 || (d & 0xc0) !== 0x80 ||
          (a === 0xf0 && b < 0x90) || (a === 0xf4 && b >= 0x90)) {
        return __td.decode(data.subarray(start, end));
      }
      const code = (((a & 7) << 18) | ((b & 0x3f) << 12) | ((c & 0x3f) << 6) | (d & 0x3f)) - 0x10000;
      value += String.fromCharCode(0xd800 | (code >>> 10), 0xdc00 | (code & 0x3ff));
    } else {
      return __td.decode(data.subarray(start, end));
    }
  }
  return value;
}
`;
