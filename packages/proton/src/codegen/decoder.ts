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
        `${ind}let ${varName} = data[offset++];`,
        `${ind}if (${varName} & 0x80) {`,
        `${ind}  let _s = 7, _b;`,
        `${ind}  ${varName} &= 0x7f;`,
        `${ind}  do { _b = data[offset++]; ${varName} |= (_b & 0x7f) << _s; _s += 7; } while (_b & 0x80);`,
        `${ind}}`,
    ].join('\n');
}

function varintDec64(varName: string, ind: string): string {
    return [
        `${ind}let ${varName} = 0n, _s = 0n, _b;`,
        `${ind}do { _b = data[offset++]; ${varName} |= BigInt(_b & 0x7f) << _s; _s += 7n; } while (_b & 0x80);`,
    ].join('\n');
}

function isVarint64(typeName: string): boolean {
    return typeName === 'uint_64' || typeName === 'int_64' || typeName === 'sint_64';
}

function isFixed64BigInt(typeName: string): boolean {
    return typeName === 'fixed_64' || typeName === 'sfixed_64';
}

const INLINE_SKIP = [
    `        const wireType = _tag & 0x7;`,
    `        if (wireType === 0) { while (data[offset] & 0x80) offset++; offset++; }`,
    `        else if (wireType === 1) offset += 8;`,
    `        else if (wireType === 2) { let _l = data[offset++]; if (_l & 0x80) { let _s = 7, _b; _l &= 0x7f; do { _b = data[offset++]; _l |= (_b & 0x7f) << _s; _s += 7; } while (_b & 0x80); } offset += _l; }`,
    `        else if (wireType === 5) offset += 4;`,
].join('\n');

export function generateDecoder(msg: ProtobufMessage, _registry: MessageRegistry): string {
    const locals = msg.fields.map((field, index) => {
        const keyword = field.isRepeated ? 'const' : 'let';
        return `  ${keyword} _f${index} = ${getDefault(field)};`;
    });
    const result = msg.fields.map((field, index) => `${field.name}: _f${index}`).join(', ');

    const L = [
        `function protobuf_decode_${msg.name}(data, offset = 0, end = data.length) {`,
        ...locals,
        `  while (offset < end) {`,
        `    let _tag = data[offset++];`,
        `    if (_tag & 0x80) {`,
        `      let _ts = 7, _tb;`,
        `      _tag &= 0x7f;`,
        `      do { _tb = data[offset++]; _tag |= (_tb & 0x7f) << _ts; _ts += 7; } while (_tb & 0x80);`,
        `    }`,
        `    switch (_tag) {`,
    ];

    msg.fields.forEach((field, index) => {
        L.push(decodeField(field, index));
    });

    L.push(
        `      default: {`,
        INLINE_SKIP,
        `        break;`,
        `      }`,
        `    }`,
        `  }`,
        `  return { ${result} };`,
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
        L.push(assign(`protobuf_decode_${typeName}(data, offset, offset + _len)`));
        L.push(`${I}offset += _len;`);
    } else if (typeName === 'string') {
        L.push(varintDec('_len', I));
        L.push(`${I}const _end = offset + _len;`);
        L.push(assign(`__td.decode(data.subarray(offset, _end))`));
        L.push(`${I}offset = _end;`);
    } else if (typeName === 'bytes') {
        L.push(varintDec('_len', I));
        L.push(`${I}const _end = offset + _len;`);
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
    } else if (typeName === 'sint_32') {
        L.push(varintDec('_val', I));
        L.push(assign(`(_val >>> 1) ^ -(_val & 1)`));
    } else if (wireType === WireType.Varint) {
        L.push(varintDec('_val', I));
        L.push(assign(`_val >>> 0`));
    } else if (typeName === 'float') {
        L.push(assign(`__readFloat32(data, offset)`));
        L.push(`${I}offset += 4;`);
    } else if (wireType === WireType.Bit32) {
        L.push(assign(`data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)`));
        L.push(`${I}offset += 4;`);
    } else if (typeName === 'double') {
        L.push(assign(`__readFloat64(data, offset)`));
        L.push(`${I}offset += 8;`);
    } else if (isFixed64BigInt(typeName)) {
        if (typeName === 'fixed_64') {
            L.push(assign(`__readFixed64(data, offset)`));
        } else {
            L.push(assign(`BigInt.asIntN(64, __readFixed64(data, offset))`));
        }
        L.push(`${I}offset += 8;`);
    } else if (wireType === WireType.Bit64) {
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
