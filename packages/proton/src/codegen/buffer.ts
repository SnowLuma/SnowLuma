export const buffers = `let __pool;
let __poolOffset = 0;
function __allocate(size) {
  if (size > 4096) return new Uint8Array(size);
  let buffer = __pool;
  if (!buffer || __poolOffset + size > buffer.length) {
    buffer = __pool = new Uint8Array(8192);
    __poolOffset = 0;
  }
  const start = __poolOffset;
  __poolOffset += size;
  return buffer.subarray(start, start + size);
}`;
