import {
    WireType,
    PRIMITIVE_TYPE_MAP,
    type ProtobufField,
    type ProtobufMessage,
} from '../codegen/model.js';

function tagValue(field: ProtobufField, wireType = field.wireType): number {
    return ((field.fieldNumber << 3) | wireType) >>> 0;
}

/** Read the low 32 bits, consuming sign-extended int32 varints without shift wraparound. */
function varintDec(
    varName: string,
    ind: string,
    end = 'end',
    maxBytes = 10,
    truthy = false,
    checkInitial = true,
): string {
    const lastShift = (maxBytes - 1) * 7;
    const lastByte = maxBytes === 5 ? 0x0f : 0x01;
    return [
        ...(checkInitial
            ? [`${ind}if (offset >= ${end}) throw new Error('Truncated protobuf varint');`]
            : []),
        `${ind}let ${varName} = data[offset++];`,
        `${ind}if (${varName} & 0x80) {`,
        `${ind}  let _s = 7, _b;`,
        `${ind}  ${varName} &= 0x7f;`,
        `${ind}  do {`,
        `${ind}    if (offset >= ${end}) throw new Error('Truncated protobuf varint');`,
        `${ind}    _b = data[offset++];`,
        `${ind}    if (_s === ${lastShift} && _b > ${lastByte}) throw new Error('Invalid protobuf varint');`,
        truthy
            ? `${ind}    ${varName} |= _b & 0x7f;`
            : `${ind}    if (_s < 32) ${varName} |= (_b & 0x7f) << _s;`,
        `${ind}    _s += 7;`,
        `${ind}  } while (_b & 0x80);`,
        `${ind}  ${varName} >>>= 0;`,
        `${ind}}`,
    ].join('\n');
}

function varintDec64(varName: string, ind: string, end: string): string {
    return [
        `${ind}let _lo = 0, _hi = 0, _s = 0, _b;`,
        `${ind}do {`,
        `${ind}  if (offset >= ${end}) throw new Error('Truncated protobuf varint');`,
        `${ind}  _b = data[offset++];`,
        `${ind}  if (_s === 63 && _b > 1) throw new Error('Invalid protobuf varint');`,
        `${ind}  if (_s < 28) _lo |= (_b & 0x7f) << _s;`,
        `${ind}  else if (_s === 28) { _lo |= (_b & 0x7f) << 28; _hi = (_b & 0x7f) >>> 4; }`,
        `${ind}  else _hi |= (_b & 0x7f) << (_s - 32);`,
        `${ind}  _s += 7;`,
        `${ind}} while (_b & 0x80);`,
        `${ind}const ${varName} = _hi === 0 ? BigInt(_lo >>> 0) : BigInt(_lo >>> 0) | (BigInt(_hi >>> 0) << 32n);`,
    ].join('\n');
}

function checkLength(length: string | number, ind: string, end: string): string {
    return `${ind}if (offset + ${length} > ${end}) throw new Error('Truncated protobuf field');`;
}

export function generateDecoder(msg: ProtobufMessage): string {
    const locals = msg.fields.map((field, index) => {
        const keyword = field.isRepeated ? 'const' : 'let';
        return `  ${keyword} _f${index} = ${getDefault(field)};`;
    });
    const result = msg.fields
        .map(
            (field, index) =>
                `${field.name === '__proto__' ? '["__proto__"]' : JSON.stringify(field.name)}: _f${index}`,
        )
        .join(', ');

    const lines = [
        `function protobuf_decode_${msg.name}(data, offset = 0, end = data.length) {`,
        `  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end > data.length || offset > end) throw new Error('Invalid protobuf bounds');`,
        ...locals,
        `  let _unknownFields = null;`,
        `  let _unknownFieldsByKey = null;`,
        `  let _unknownTotalOccurrences = 0;`,
        `  let _unknownOmittedOccurrences = 0;`,
        `  let _unknownOmittedByteLength = 0;`,

        `  while (offset < end) {`,
        varintDec('_tag', '    ', 'end', 5, false, false),
        `    if ((_tag >>> 3) === 0) throw new Error('Invalid protobuf field number');`,
        `    switch (_tag) {`,
    ];

    msg.fields.forEach((field, index) => {
        lines.push(`      case ${tagValue(field)}: {`);
        lines.push(...decodeValue(field, index, '        ', 'end'));
        lines.push(`        break;`, `      }`);

        if (field.isRepeated && !field.isMessage && field.wireType !== WireType.LengthDelim) {
            lines.push(
                `      case ${tagValue(field, WireType.LengthDelim)}: {`,
                varintDec('_len', '        ', 'end', 5),
                checkLength('_len', '        ', 'end'),
                `        const _packedEnd = offset + _len;`,
                `        while (offset < _packedEnd) {`,
                ...decodeValue(field, index, '          ', '_packedEnd'),
                `        }`,
                `        break;`,
                `      }`,
            );
        }
    });

    lines.push(
        `      default: {`,
        `        const _unknownStart = offset;`,
        `        const wireType = _tag & 0x7;`,
        `        offset = __skipUnknownField(data, offset, end, wireType, _tag >>> 3);`,
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
    return lines.join('\n');
}

/** Shared by ordinary fields and packed repeated payloads. */
function decodeValue(field: ProtobufField, index: number, ind: string, end: string): string[] {
    const { typeName, wireType, isMessage, isRepeated } = field;
    const local = `_f${index}`;
    const assign = (expr: string) =>
        isRepeated ? `${ind}${local}.push(${expr});` : `${ind}${local} = ${expr};`;
    const lines: string[] = [];

    if (wireType === WireType.Bit32) {
        lines.push(checkLength(4, ind, end));
    }

    if (wireType === WireType.Bit64) {
        lines.push(checkLength(8, ind, end));
    }

    if (isMessage || typeName === 'string' || typeName === 'bytes') {
        lines.push(varintDec('_len', ind, end, 5), checkLength('_len', ind, end));

        if (isMessage) {
            lines.push(assign(`protobuf_decode_${typeName}(data, offset, offset + _len)`));
        } else if (typeName === 'string') {
            lines.push(
                assign(
                    `_len <= 32 ? __utf8Read(data, offset, offset + _len) : __utf8ReadLong(data, offset, offset + _len)`,
                ),
            );
        } else {
            lines.push(assign(`data.slice(offset, offset + _len)`));
        }

        lines.push(`${ind}offset += _len;`);
    } else if (typeName === 'uint_64' || typeName === 'int_64' || typeName === 'sint_64') {
        lines.push(varintDec64('_val', ind, end));
        const value =
            typeName === 'uint_64'
                ? '_val'
                : typeName === 'int_64'
                  ? 'BigInt.asIntN(64, _val)'
                  : '__zigZagDecode64(_val)';
        lines.push(assign(value));
    } else if (wireType === WireType.Varint) {
        lines.push(varintDec('_val', ind, end, 10, typeName === 'bool'));
        const value =
            typeName === 'bool'
                ? '_val !== 0'
                : typeName === 'sint_32'
                  ? '(_val >>> 1) ^ -(_val & 1)'
                  : typeName === 'int_32'
                    ? '_val | 0'
                    : '_val';
        lines.push(assign(value));
    } else if (typeName === 'float') {
        lines.push(assign('__readFloat32(data, offset)'), `${ind}offset += 4;`);
    } else if (wireType === WireType.Bit32) {
        const value =
            '(data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24))';
        lines.push(
            assign(typeName === 'fixed_32' ? `${value} >>> 0` : value),
            `${ind}offset += 4;`,
        );
    } else if (typeName === 'double') {
        lines.push(assign('__readFloat64(data, offset)'), `${ind}offset += 8;`);
    } else if (typeName === 'fixed_64' || typeName === 'sfixed_64') {
        const value =
            typeName === 'fixed_64'
                ? '__readFixed64(data, offset)'
                : 'BigInt.asIntN(64, __readFixed64(data, offset))';
        lines.push(assign(value), `${ind}offset += 8;`);
    } else {
        throw new Error(`Unsupported protobuf field type: ${typeName}`);
    }

    return lines;
}

function getDefault(field: ProtobufField): string {
    if (field.isRepeated) {
        return '[]';
    }

    if (field.isOptional || field.isMessage) {
        return 'null';
    }

    const primitive = PRIMITIVE_TYPE_MAP[field.typeName];
    return primitive ? primitive.defaultValue : 'null';
}
