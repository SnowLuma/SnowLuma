// Bound unknown fields and groups to the current message frame.
export const unknownFields = `
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
`;
