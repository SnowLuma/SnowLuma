const HEX_CHARS = '0123456789abcdef';
const HEX_CHARS_UPPER = '0123456789ABCDEF';

export function toHex(data: Uint8Array | Buffer): string {
  let h = '';
  for (const b of data) {
    h += HEX_CHARS[b >> 4];
    h += HEX_CHARS[b & 0xf];
  }
  return h;
}

export function toHexUpper(data: Uint8Array | Buffer): string {
  let h = '';
  for (const b of data) {
    h += HEX_CHARS_UPPER[b >> 4];
    h += HEX_CHARS_UPPER[b & 0xf];
  }
  return h;
}

export function hexPreview(data: Uint8Array | Buffer, maxBytes = 64): string {
  const limit = Math.max(0, Math.min(maxBytes, data.length));
  const head = toHex(data.subarray(0, limit));
  return data.length > limit ? `${head}...` : head;
}

export function fromHex(hex: string): Buffer {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string length');
  const buf = Buffer.alloc(hex.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return buf;
}
