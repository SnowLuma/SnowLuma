import { WireType, PRIMITIVE_TYPE_MAP, type ProtobufField, type ProtobufMessage, type MessageRegistry } from '../ast/types.js';

function tagValue(field: ProtobufField): number {
  const wireType = field.isMessage || field.typeName === 'string' || field.typeName === 'bytes'
    ? WireType.LengthDelim
    : field.wireType;
  return ((field.fieldNumber << 3) | wireType) >>> 0;
}

/** Emit inline varint decode, storing result in `varName`. */
function varintDec(varName: string, ind: string): string {
  return [
    `${ind}const [${varName}, ${varName}_offset] = __readVarint32(data, offset, end);`,
    `${ind}offset = ${varName}_offset;`,
  ].join('\n');
}

function varintDec64(varName: string, ind: string): string {
  return [
    `${ind}const [${varName}, ${varName}_offset] = __readVarint64(data, offset, end);`,
    `${ind}offset = ${varName}_offset;`,
  ].join('\n');
}

function varintDec32Value(varName: string, ind: string): string {
  return [
    `${ind}const [${varName}, ${varName}_offset] = __readVarint32Value(data, offset, end);`,
    `${ind}offset = ${varName}_offset;`,
  ].join('\n');
}

function isVarint64(typeName: string): boolean {
  return typeName === 'uint_64' || typeName === 'int_64' || typeName === 'sint_64';
}

function isFixed64BigInt(typeName: string): boolean {
  return typeName === 'fixed_64' || typeName === 'sfixed_64';
}

const INLINE_SKIP = `        offset = __skipUnknownField(data, offset, end, wireType, _tag >>> 3);`;

export function generateDecoder(msg: ProtobufMessage, _registry: MessageRegistry): string {
  const locals = msg.fields.map((field, index) => {
    const keyword = field.isRepeated ? 'const' : 'let';
    return `  ${keyword} _f${index} = ${getDefault(field)};`;
  });
  const result = msg.fields.map((field, index) => `${field.name}: _f${index}`).join(', ');

  const L = [
    `function protobuf_decode_${msg.name}(data, offset = 0, end = data.length) {`,
    `  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || end > data.length) {`,
    `    throw new Error('protobuf decoder bounds are invalid');`,
    `  }`,
    ...locals,
    `  let _unknownFields = null;`,
    `  let _unknownFieldsByKey = null;`,
    `  let _unknownTotalOccurrences = 0;`,
    `  let _unknownOmittedOccurrences = 0;`,
    `  let _unknownOmittedByteLength = 0;`,
    `  while (offset < end) {`,
    `    const _fieldStart = offset;`,
    `    const [_tag, _tagOffset] = __readVarint32(data, offset, end);`,
    `    offset = _tagOffset;`,
    `    if ((_tag >>> 3) === 0) throw new Error('protobuf field number 0 is invalid');`,
    `    switch (_tag) {`,
  ];

  msg.fields.forEach((field, index) => {
    L.push(decodeField(field, index));
  });

  L.push(
    `      default: {`,
    `        const _unknownStart = offset;`,
    `        const wireType = _tag & 0x7;`,
    INLINE_SKIP,
    `        const _unknownFieldNumber = _tag >>> 3;`,
    `        const _unknownByteLength = offset - _unknownStart;`,
    `        const _unknownKey = (_unknownFieldNumber * 8) + wireType;`,
    `        _unknownTotalOccurrences++;`,
    `        const _knownUnknown = _unknownFieldsByKey?.get(_unknownKey);`,
    `        if (_knownUnknown) {`,
    `          _knownUnknown.count++;`,
    `          _knownUnknown.totalByteLength += _unknownByteLength;`,
    `        } else if ((_unknownFields?.length ?? 0) < 64) {`,
    `          const _unknown = {`,
    `            fieldNumber: _unknownFieldNumber,`,
    `            wireType,`,
    `            count: 1,`,
    `            totalByteLength: _unknownByteLength,`,
    `          };`,
    `          (_unknownFields ??= []).push(_unknown);`,
    `          (_unknownFieldsByKey ??= new Map()).set(_unknownKey, _unknown);`,
    `        } else {`,
    `          _unknownOmittedOccurrences++;`,
    `          _unknownOmittedByteLength += _unknownByteLength;`,
    `        }`,
    `        break;`,
    `      }`,
    `    }`,
    `    if (offset <= _fieldStart || offset > end) throw new Error('protobuf decoder made invalid progress');`,
    `  }`,
    `  const _result = { ${result} };`,
    `  if (_unknownTotalOccurrences > 0) Object.defineProperty(`,
    `    _result,`,
    `    Symbol.for('snowluma.proton.unknownFields'),`,
    `    {`,
    `      value: {`,
    `        fields: _unknownFields ?? [],`,
    `        totalOccurrences: _unknownTotalOccurrences,`,
    `        omittedOccurrences: _unknownOmittedOccurrences,`,
    `        omittedByteLength: _unknownOmittedByteLength,`,
    `      },`,
    `      enumerable: false,`,
    `    },`,
    `  );`,
    `  return _result;`,
    `}`,
  );
  return L.join('\n');
}

function decodeField(field: ProtobufField, index: number): string {
  const { typeName, wireType, isMessage, isRepeated } = field;
  const I = '        ';
  const local = `_f${index}`;
  const assign = (expr: string) => isRepeated
    ? `${I}${local}.push(${expr});`
    : `${I}${local} = ${expr};`;

  const L: string[] = [`      case ${tagValue(field)}: {`];

  if (isMessage) {
    L.push(varintDec('_len', I));
    L.push(`${I}const _end = __checkedEnd(offset, _len, end);`);
    L.push(assign(`protobuf_decode_${typeName}(data, offset, _end)`));
    L.push(`${I}offset = _end;`);
  } else if (typeName === 'string') {
    L.push(varintDec('_len', I));
    L.push(`${I}const _end = __checkedEnd(offset, _len, end);`);
    L.push(assign(`__td.decode(data.subarray(offset, _end))`));
    L.push(`${I}offset = _end;`);
  } else if (typeName === 'bytes') {
    L.push(varintDec('_len', I));
    L.push(`${I}const _end = __checkedEnd(offset, _len, end);`);
    L.push(assign(`data.slice(offset, _end)`));
    L.push(`${I}offset = _end;`);
  } else if (typeName === 'bool') {
    L.push(varintDec('_val', I));
    L.push(assign(`_val !== 0`));
  } else if (isVarint64(typeName)) {
    L.push(varintDec64('_val', I));
    if (typeName === 'uint_64') {
      L.push(assign(`_val`));
    } else if (typeName === 'int_64') {
      L.push(assign(`BigInt.asIntN(64, _val)`));
    } else {
      L.push(assign(`__zigZagDecode64(_val)`));
    }
  } else if (typeName === 'int_32') {
    // Protobuf encodes negative int32 values as a sign-extended 10-byte
    // varint. Read the full uint64 representation, then keep its signed low
    // 32 bits.
    L.push(varintDec64('_val', I));
    L.push(assign(`Number(BigInt.asIntN(32, _val))`));
  } else if (typeName === 'sint_32') {
    L.push(varintDec('_val', I));
    L.push(assign(`(_val >>> 1) ^ -(_val & 1)`));
  } else if (wireType === WireType.Varint) {
    L.push(varintDec32Value('_val', I));
    L.push(assign(`_val >>> 0`));
  } else if (typeName === 'float') {
    L.push(`${I}if (end - offset < 4) throw new Error('protobuf truncated float field');`);
    L.push(assign(`__readFloat32(data, offset)`));
    L.push(`${I}offset += 4;`);
  } else if (wireType === WireType.Bit32) {
    L.push(`${I}if (end - offset < 4) throw new Error('protobuf truncated fixed32 field');`);
    L.push(assign(`data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)`));
    L.push(`${I}offset += 4;`);
  } else if (typeName === 'double') {
    L.push(`${I}if (end - offset < 8) throw new Error('protobuf truncated double field');`);
    L.push(assign(`__readFloat64(data, offset)`));
    L.push(`${I}offset += 8;`);
  } else if (isFixed64BigInt(typeName)) {
    L.push(`${I}if (end - offset < 8) throw new Error('protobuf truncated fixed64 field');`);
    if (typeName === 'fixed_64') {
      L.push(assign(`__readFixed64(data, offset)`));
    } else {
      L.push(assign(`BigInt.asIntN(64, __readFixed64(data, offset))`));
    }
    L.push(`${I}offset += 8;`);
  } else if (wireType === WireType.Bit64) {
    L.push(`${I}if (end - offset < 8) throw new Error('protobuf truncated fixed64 field');`);
    L.push(assign(`data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)`));
    L.push(`${I}offset += 8;`);
  }

  L.push(`${I}break;`, `      }`);
  return L.join('\n');
}

function getDefault(field: ProtobufField): string {
  if (field.isRepeated) return '[]';
  if (field.isOptional || field.isMessage) return 'null';
  const primitive = PRIMITIVE_TYPE_MAP[field.typeName];
  return primitive ? primitive.defaultValue : 'null';
}
