import { WireType, type ProtobufField, type ProtobufMessage, type MessageRegistry } from '../ast/types.js';

/**
 * Pre-compute tag bytes at codegen time.
 * Field 1 + Varint(0) -> [0x08], Field 1 + LenDelim(2) -> [0x0a], etc.
 */
function computeTagBytes(fieldNumber: number, wireType: number): number[] {
    let value = ((fieldNumber << 3) | wireType) >>> 0;
    const bytes: number[] = [];
    while (value > 0x7f) {
        bytes.push((value & 0x7f) | 0x80);
        value >>>= 7;
    }
    bytes.push(value & 0x7f);
    return bytes;
}

function writeTag(fieldNumber: number, wireType: number, ind: string): string {
    return computeTagBytes(fieldNumber, wireType)
        .map(byte => `${ind}buf[offset++] = ${byte};`)
        .join('\n');
}

function varintSize(varName: string, ind: string): string {
    return `${ind}size += ${varName} < 0x80 ? 1 : ${varName} < 0x4000 ? 2 : ${varName} < 0x200000 ? 3 : ${varName} < 0x10000000 ? 4 : 5;`;
}

function writeVarint(expr: string, ind: string): string {
    return [
        `${ind}let _v = ${expr};`,
        `${ind}if (_v < 0x80) {`,
        `${ind}  buf[offset++] = _v;`,
        `${ind}} else if (_v < 0x4000) {`,
        `${ind}  buf[offset++] = (_v & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = _v >>> 7;`,
        `${ind}} else if (_v < 0x200000) {`,
        `${ind}  buf[offset++] = (_v & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = ((_v >>> 7) & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = _v >>> 14;`,
        `${ind}} else if (_v < 0x10000000) {`,
        `${ind}  buf[offset++] = (_v & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = ((_v >>> 7) & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = ((_v >>> 14) & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = _v >>> 21;`,
        `${ind}} else {`,
        `${ind}  buf[offset++] = (_v & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = ((_v >>> 7) & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = ((_v >>> 14) & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = ((_v >>> 21) & 0x7f) | 0x80;`,
        `${ind}  buf[offset++] = _v >>> 28;`,
        `${ind}}`,
    ].join('\n');
}

function isVarint64(typeName: string): boolean {
    return typeName === 'uint_64' || typeName === 'int_64' || typeName === 'sint_64';
}

function isFixed64BigInt(typeName: string): boolean {
    return typeName === 'fixed_64' || typeName === 'sfixed_64';
}

function bigintVarintExpr(typeName: string, expr: string): string {
    if (typeName === 'uint_64') return `BigInt.asUintN(64, ${expr})`;
    if (typeName === 'int_64') return `BigInt.asUintN(64, ${expr})`;
    return `__zigZagEncode64(${expr})`;
}

interface EncoderBlock {
    declare: string[];
    size: string[];
    write: string[];
}

export function generateEncoder(msg: ProtobufMessage, _registry: MessageRegistry): string {
    const blocks = msg.fields.map((field, index) => field.isRepeated ? buildRepeatedBlock(field, index) : buildSingularBlock(field, index));

    const L = [
        `function protobuf_encode_${msg.name}(obj) {`,
        `  let size = 0;`,
        ...blocks.flatMap(block => block.declare),
        ...blocks.flatMap(block => block.size),
        `  const buf = new Uint8Array(size);`,
        `  let offset = 0;`,
        ...blocks.flatMap(block => block.write),
        `  return buf;`,
        `}`,
    ];
    return L.join('\n');
}

function buildSingularBlock(field: ProtobufField, index: number): EncoderBlock {
    const { name, fieldNumber, typeName, wireType, isMessage } = field;
    const valueVar = `_f${index}`;
    const cacheVar = `_c${index}`;
    const tagLength = computeTagBytes(fieldNumber, isMessage || typeName === 'string' || typeName === 'bytes' ? 2 : wireType).length;

    if (isMessage) {
        return {
            declare: [`  const ${valueVar} = obj.${name};`, `  let ${cacheVar};`],
            size: [
                `  if (${valueVar} != null) {`,
                `    ${cacheVar} = protobuf_encode_${typeName}(${valueVar});`,
                `    const _len = ${cacheVar}.length;`,
                `    size += ${tagLength};`,
                varintSize('_len', '    '),
                `    size += _len;`,
                `  }`,
            ],
            write: [
                `  if (${valueVar} != null) {`,
                `    const _data = ${cacheVar};`,
                writeTag(fieldNumber, 2, '    '),
                `    const _len = _data.length;`,
                writeVarint('_len', '    '),
                `    buf.set(_data, offset);`,
                `    offset += _len;`,
                `  }`,
            ],
        };
    }

    if (typeName === 'string') {
        return {
            declare: [`  const ${valueVar} = obj.${name};`, `  let ${cacheVar};`],
            size: [
                `  if (${valueVar} != null && ${valueVar} !== "") {`,
                `    ${cacheVar} = __utf8Len(${valueVar});`,
                `    const _len = ${cacheVar};`,
                `    size += ${tagLength};`,
                varintSize('_len', '    '),
                `    size += _len;`,
                `  }`,
            ],
            write: [
                `  if (${valueVar} != null && ${valueVar} !== "") {`,
                writeTag(fieldNumber, 2, '    '),
                `    const _len = ${cacheVar};`,
                writeVarint('_len', '    '),
                `    offset = __utf8Write(buf, offset, ${valueVar});`,
                `  }`,
            ],
        };
    }

    if (typeName === 'bytes') {
        return {
            declare: [`  const ${valueVar} = obj.${name};`],
            size: [
                `  if (${valueVar} != null && ${valueVar}.length > 0) {`,
                `    const _len = ${valueVar}.length;`,
                `    size += ${tagLength};`,
                varintSize('_len', '    '),
                `    size += _len;`,
                `  }`,
            ],
            write: [
                `  if (${valueVar} != null && ${valueVar}.length > 0) {`,
                writeTag(fieldNumber, 2, '    '),
                `    const _len = ${valueVar}.length;`,
                writeVarint('_len', '    '),
                `    buf.set(${valueVar}, offset);`,
                `    offset += _len;`,
                `  }`,
            ],
        };
    }

    if (typeName === 'bool') {
        return {
            declare: [`  const ${valueVar} = obj.${name};`],
            size: [`  if (${valueVar} === true) size += ${tagLength + 1};`],
            write: [
                `  if (${valueVar} === true) {`,
                writeTag(fieldNumber, 0, '    '),
                `    buf[offset++] = 1;`,
                `  }`,
            ],
        };
    }

    if (isVarint64(typeName)) {
        const bigintExpr = bigintVarintExpr(typeName, valueVar);
        return {
            declare: [`  const ${valueVar} = obj.${name};`],
            size: [
                `  if (${valueVar} != null && ${valueVar} !== 0n) {`,
                `    const _val = ${bigintExpr};`,
                `    size += ${tagLength};`,
                `    size += __varint64Size(_val);`,
                `  }`,
            ],
            write: [
                `  if (${valueVar} != null && ${valueVar} !== 0n) {`,
                `    const _val = ${bigintExpr};`,
                writeTag(fieldNumber, 0, '    '),
                `    offset = __writeVarint64(buf, offset, _val);`,
                `  }`,
            ],
        };
    }

    if (typeName === 'sint_32') {
        return {
            declare: [`  const ${valueVar} = obj.${name};`],
            size: [
                `  if (${valueVar} != null && ${valueVar} !== 0) {`,
                `    const _val = ((${valueVar} << 1) ^ (${valueVar} >> 31)) >>> 0;`,
                `    size += ${tagLength};`,
                varintSize('_val', '    '),
                `  }`,
            ],
            write: [
                `  if (${valueVar} != null && ${valueVar} !== 0) {`,
                writeTag(fieldNumber, 0, '    '),
                writeVarint(`((${valueVar} << 1) ^ (${valueVar} >> 31)) >>> 0`, '    '),
                `  }`,
            ],
        };
    }

    if (wireType === WireType.Varint) {
        return {
            declare: [`  const ${valueVar} = obj.${name};`],
            size: [
                `  if (${valueVar} != null && ${valueVar} !== 0) {`,
                `    const _val = ${valueVar} >>> 0;`,
                `    size += ${tagLength};`,
                varintSize('_val', '    '),
                `  }`,
            ],
            write: [
                `  if (${valueVar} != null && ${valueVar} !== 0) {`,
                writeTag(fieldNumber, 0, '    '),
                writeVarint(`${valueVar} >>> 0`, '    '),
                `  }`,
            ],
        };
    }

    if (typeName === 'float') {
        return {
            declare: [`  const ${valueVar} = obj.${name};`],
            size: [`  if (${valueVar} != null && ${valueVar} !== 0) size += ${tagLength + 4};`],
            write: [
                `  if (${valueVar} != null && ${valueVar} !== 0) {`,
                writeTag(fieldNumber, 5, '    '),
                `    offset = __writeFloat32(buf, offset, ${valueVar});`,
                `  }`,
            ],
        };
    }

    if (wireType === WireType.Bit32) {
        return {
            declare: [`  const ${valueVar} = obj.${name};`],
            size: [`  if (${valueVar} != null && ${valueVar} !== 0) size += ${tagLength + 4};`],
            write: [
                `  if (${valueVar} != null && ${valueVar} !== 0) {`,
                writeTag(fieldNumber, 5, '    '),
                `    const _val = ${valueVar};`,
                `    buf[offset++] = _val & 0xff;`,
                `    buf[offset++] = (_val >> 8) & 0xff;`,
                `    buf[offset++] = (_val >> 16) & 0xff;`,
                `    buf[offset++] = (_val >> 24) & 0xff;`,
                `  }`,
            ],
        };
    }

    if (typeName === 'double') {
        return {
            declare: [`  const ${valueVar} = obj.${name};`],
            size: [`  if (${valueVar} != null && ${valueVar} !== 0) size += ${tagLength + 8};`],
            write: [
                `  if (${valueVar} != null && ${valueVar} !== 0) {`,
                writeTag(fieldNumber, 1, '    '),
                `    offset = __writeFloat64(buf, offset, ${valueVar});`,
                `  }`,
            ],
        };
    }

    if (isFixed64BigInt(typeName)) {
        return {
            declare: [`  const ${valueVar} = obj.${name};`],
            size: [`  if (${valueVar} != null && ${valueVar} !== 0n) size += ${tagLength + 8};`],
            write: [
                `  if (${valueVar} != null && ${valueVar} !== 0n) {`,
                writeTag(fieldNumber, 1, '    '),
                `    offset = __writeFixed64(buf, offset, ${valueVar});`,
                `  }`,
            ],
        };
    }

    if (wireType === WireType.Bit64) {
        return {
            declare: [`  const ${valueVar} = obj.${name};`],
            size: [`  if (${valueVar} != null && ${valueVar} !== 0) size += ${tagLength + 8};`],
            write: [
                `  if (${valueVar} != null && ${valueVar} !== 0) {`,
                writeTag(fieldNumber, 1, '    '),
                `    const _val = ${valueVar};`,
                `    buf[offset++] = _val & 0xff;`,
                `    buf[offset++] = (_val >> 8) & 0xff;`,
                `    buf[offset++] = (_val >> 16) & 0xff;`,
                `    buf[offset++] = (_val >> 24) & 0xff;`,
                `    buf[offset++] = 0;`,
                `    buf[offset++] = 0;`,
                `    buf[offset++] = 0;`,
                `    buf[offset++] = 0;`,
                `  }`,
            ],
        };
    }

    return { declare: [], size: [], write: [] };
}

function buildRepeatedBlock(field: ProtobufField, index: number): EncoderBlock {
    const { name, fieldNumber, typeName, wireType, isMessage } = field;
    const arrayVar = `_f${index}`;
    const cacheVar = `_c${index}`;
    const tagWireType = isMessage || typeName === 'string' || typeName === 'bytes' ? 2 : wireType;
    const tagLength = computeTagBytes(fieldNumber, tagWireType).length;

    if (isMessage) {
        return {
            declare: [`  const ${arrayVar} = obj.${name};`, `  let ${cacheVar};`],
            size: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    ${cacheVar} = new Array(${arrayVar}.length);`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                `      const _data = protobuf_encode_${typeName}(${arrayVar}[_i]);`,
                `      ${cacheVar}[_i] = _data;`,
                `      const _len = _data.length;`,
                `      size += ${tagLength};`,
                varintSize('_len', '      '),
                `      size += _len;`,
                `    }`,
                `  }`,
            ],
            write: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                `      const _data = ${cacheVar}[_i];`,
                writeTag(fieldNumber, 2, '      '),
                `      const _len = _data.length;`,
                writeVarint('_len', '      '),
                `      buf.set(_data, offset);`,
                `      offset += _len;`,
                `    }`,
                `  }`,
            ],
        };
    }

    if (typeName === 'string') {
        return {
            declare: [`  const ${arrayVar} = obj.${name};`, `  let ${cacheVar};`],
            size: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    ${cacheVar} = new Array(${arrayVar}.length);`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                `      const _len = __utf8Len(${arrayVar}[_i]);`,
                `      ${cacheVar}[_i] = _len;`,
                `      size += ${tagLength};`,
                varintSize('_len', '      '),
                `      size += _len;`,
                `    }`,
                `  }`,
            ],
            write: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                `      const _len = ${cacheVar}[_i];`,
                writeTag(fieldNumber, 2, '      '),
                writeVarint('_len', '      '),
                `      offset = __utf8Write(buf, offset, ${arrayVar}[_i]);`,
                `    }`,
                `  }`,
            ],
        };
    }

    if (typeName === 'bytes') {
        return {
            declare: [`  const ${arrayVar} = obj.${name};`],
            size: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                `      const _data = ${arrayVar}[_i];`,
                `      const _len = _data.length;`,
                `      size += ${tagLength};`,
                varintSize('_len', '      '),
                `      size += _len;`,
                `    }`,
                `  }`,
            ],
            write: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                `      const _data = ${arrayVar}[_i];`,
                writeTag(fieldNumber, 2, '      '),
                `      const _len = _data.length;`,
                writeVarint('_len', '      '),
                `      buf.set(_data, offset);`,
                `      offset += _len;`,
                `    }`,
                `  }`,
            ],
        };
    }

    if (typeName === 'bool') {
        return {
            declare: [`  const ${arrayVar} = obj.${name};`],
            size: [`  if (${arrayVar} != null && ${arrayVar}.length > 0) size += ${arrayVar}.length * ${tagLength + 1};`],
            write: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                writeTag(fieldNumber, 0, '      '),
                `      buf[offset++] = ${arrayVar}[_i] ? 1 : 0;`,
                `    }`,
                `  }`,
            ],
        };
    }

    if (isVarint64(typeName)) {
        const bigintExpr = bigintVarintExpr(typeName, `${arrayVar}[_i]`);
        return {
            declare: [`  const ${arrayVar} = obj.${name};`],
            size: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                `      const _val = ${bigintExpr};`,
                `      size += ${tagLength};`,
                `      size += __varint64Size(_val);`,
                `    }`,
                `  }`,
            ],
            write: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                `      const _val = ${bigintExpr};`,
                writeTag(fieldNumber, 0, '      '),
                `      offset = __writeVarint64(buf, offset, _val);`,
                `    }`,
                `  }`,
            ],
        };
    }

    if (typeName === 'sint_32') {
        return {
            declare: [`  const ${arrayVar} = obj.${name};`],
            size: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                `      const _val = ((${arrayVar}[_i] << 1) ^ (${arrayVar}[_i] >> 31)) >>> 0;`,
                `      size += ${tagLength};`,
                varintSize('_val', '      '),
                `    }`,
                `  }`,
            ],
            write: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                writeTag(fieldNumber, 0, '      '),
                writeVarint(`((${arrayVar}[_i] << 1) ^ (${arrayVar}[_i] >> 31)) >>> 0`, '      '),
                `    }`,
                `  }`,
            ],
        };
    }

    if (wireType === WireType.Varint) {
        return {
            declare: [`  const ${arrayVar} = obj.${name};`],
            size: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                `      const _val = ${arrayVar}[_i] >>> 0;`,
                `      size += ${tagLength};`,
                varintSize('_val', '      '),
                `    }`,
                `  }`,
            ],
            write: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                writeTag(fieldNumber, 0, '      '),
                writeVarint(`${arrayVar}[_i] >>> 0`, '      '),
                `    }`,
                `  }`,
            ],
        };
    }

    if (typeName === 'float') {
        return {
            declare: [`  const ${arrayVar} = obj.${name};`],
            size: [`  if (${arrayVar} != null && ${arrayVar}.length > 0) size += ${arrayVar}.length * ${tagLength + 4};`],
            write: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                writeTag(fieldNumber, 5, '      '),
                `      offset = __writeFloat32(buf, offset, ${arrayVar}[_i]);`,
                `    }`,
                `  }`,
            ],
        };
    }

    if (wireType === WireType.Bit32) {
        return {
            declare: [`  const ${arrayVar} = obj.${name};`],
            size: [`  if (${arrayVar} != null && ${arrayVar}.length > 0) size += ${arrayVar}.length * ${tagLength + 4};`],
            write: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                writeTag(fieldNumber, 5, '      '),
                `      const _val = ${arrayVar}[_i];`,
                `      buf[offset++] = _val & 0xff;`,
                `      buf[offset++] = (_val >> 8) & 0xff;`,
                `      buf[offset++] = (_val >> 16) & 0xff;`,
                `      buf[offset++] = (_val >> 24) & 0xff;`,
                `    }`,
                `  }`,
            ],
        };
    }

    if (typeName === 'double') {
        return {
            declare: [`  const ${arrayVar} = obj.${name};`],
            size: [`  if (${arrayVar} != null && ${arrayVar}.length > 0) size += ${arrayVar}.length * ${tagLength + 8};`],
            write: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                writeTag(fieldNumber, 1, '      '),
                `      offset = __writeFloat64(buf, offset, ${arrayVar}[_i]);`,
                `    }`,
                `  }`,
            ],
        };
    }

    if (isFixed64BigInt(typeName)) {
        return {
            declare: [`  const ${arrayVar} = obj.${name};`],
            size: [`  if (${arrayVar} != null && ${arrayVar}.length > 0) size += ${arrayVar}.length * ${tagLength + 8};`],
            write: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                writeTag(fieldNumber, 1, '      '),
                `      offset = __writeFixed64(buf, offset, ${arrayVar}[_i]);`,
                `    }`,
                `  }`,
            ],
        };
    }

    if (wireType === WireType.Bit64) {
        return {
            declare: [`  const ${arrayVar} = obj.${name};`],
            size: [`  if (${arrayVar} != null && ${arrayVar}.length > 0) size += ${arrayVar}.length * ${tagLength + 8};`],
            write: [
                `  if (${arrayVar} != null && ${arrayVar}.length > 0) {`,
                `    for (let _i = 0; _i < ${arrayVar}.length; _i++) {`,
                writeTag(fieldNumber, 1, '      '),
                `      const _val = ${arrayVar}[_i];`,
                `      buf[offset++] = _val & 0xff;`,
                `      buf[offset++] = (_val >> 8) & 0xff;`,
                `      buf[offset++] = (_val >> 16) & 0xff;`,
                `      buf[offset++] = (_val >> 24) & 0xff;`,
                `      buf[offset++] = 0;`,
                `      buf[offset++] = 0;`,
                `      buf[offset++] = 0;`,
                `      buf[offset++] = 0;`,
                `    }`,
                `  }`,
            ],
        };
    }

    return { declare: [], size: [], write: [] };
}
