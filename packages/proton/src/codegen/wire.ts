// Protobuf wire format helpers — used directly by wire.test.ts
// The generated code no longer depends on these (everything is inlined).

export function encodeVarint(value: number, buf: number[]): void {
  value = value >>> 0;
  while (value > 0x7f) {
    buf.push((value & 0x7f) | 0x80);
    value = value >>> 7;
  }
  buf.push(value & 0x7f);
}

export function decodeVarint(data: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = data[offset++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return [result >>> 0, offset];
}

export function writeTag(fieldNumber: number, wireType: number, buf: number[]): void {
  encodeVarint((fieldNumber << 3) | wireType, buf);
}

export function writeString(value: string, buf: number[]): void {
  const encoded = new TextEncoder().encode(value);
  encodeVarint(encoded.length, buf);
  for (let i = 0; i < encoded.length; i++) buf.push(encoded[i]);
}

export function readString(data: Uint8Array, offset: number, length: number): string {
  return new TextDecoder().decode(data.subarray(offset, offset + length));
}

export function writeBytes(value: Uint8Array, buf: number[]): void {
  encodeVarint(value.length, buf);
  for (let i = 0; i < value.length; i++) buf.push(value[i]);
}

export function skipField(data: Uint8Array, offset: number, wireType: number): number {
  switch (wireType) {
    case 0: while (data[offset] & 0x80) offset++; return offset + 1;
    case 1: return offset + 8;
    case 2: { const [len, o] = decodeVarint(data, offset); return o + len; }
    case 5: return offset + 4;
    default: throw new Error(`Unknown wire type: ${wireType}`);
  }
}
