import { WireType, type ProtobufField } from './model.js';
import { computeTagBytes, varintSize, writeTag, writeVarint } from './write.js';

export interface FieldBlock {
    declare: string[];
    size: string[];
    write: string[];
}

export function fieldBlock(field: ProtobufField, index: number, shared: boolean): FieldBlock {
    const { fieldNumber, wireType, typeName, isRepeated, isMessage } = field;
    const variable = `_f${index}`;
    const item = isRepeated ? `${variable}[_i]` : variable;
    const cached = `_c${index}`;
    const slot = isRepeated ? `${cached}[_i]` : cached;
    const indent = isRepeated ? '      ' : '    ';
    const tag = computeTagBytes(fieldNumber, wireType).length;
    const condition = isRepeated
        ? `${variable} != null && ${variable}.length > 0`
        : presence(field, variable);
    const start = [`  if (${condition}) {`];
    const loop = isRepeated ? [`    for (let _i = 0; _i < ${variable}.length; _i++) {`] : [];
    const end = [...(isRepeated ? ['    }'] : []), '  }'];
    const declare = [`  const ${variable} = obj[${JSON.stringify(field.name)}];`];
    const setup: string[] = [];
    const size: string[] = [];
    const write: string[] = [writeTag(fieldNumber, wireType, indent)];
    const emit = (lines: string[]) => lines.map((line) => indent + line);

    if (wireType === WireType.LengthDelim) {
        if (isMessage) {
            size.push(
                ...emit([
                    'const _slot = sizes.length;',
                    'sizes.push(0);',
                    `const _len = __size_${typeName}(${item}, sizes);`,
                    'sizes[_slot] = _len;',
                ]),
            );
            write.push(...emit(['const _len = sizes[sizes[0]++];']));
        } else if (typeName === 'string') {
            if (shared) {
                size.push(...emit([`const _len = __utf8Len(${item});`, 'sizes.push(_len);']));
                write.push(...emit(['const _len = sizes[sizes[0]++];']));
            } else {
                declare.push(`  let ${cached};`);

                if (isRepeated) {
                    setup.push(`    ${cached} = new Array(${variable}.length);`);
                }

                size.push(...emit([`const _len = __utf8Len(${item});`, `${slot} = _len;`]));
                write.push(...emit([`const _len = ${slot};`]));
            }
        } else {
            size.push(...emit([`const _len = ${item}.length;`]));
            write.push(...emit([`const _len = ${item}.length;`]));
        }

        size.push(...emit([`size += ${tag} + _len;`]), varintSize('_len', indent));
        write.push(
            writeVarint('_len', indent),
            ...emit(
                isMessage
                    ? [`offset = __write_${typeName}(${item}, buf, offset, sizes);`]
                    : typeName === 'string'
                      ? [
                            `offset = _len >= 128 ? __utf8WriteLong(buf, offset, ${item}) : _len === ${item}.length ? __asciiWrite(buf, offset, ${item}) : __utf8Write(buf, offset, ${item});`,
                        ]
                      : [`buf.set(${item}, offset);`, 'offset += _len;'],
            ),
        );
    } else if (typeName === 'bool') {
        size.push(...emit([`size += ${tag + 1};`]));
        write.push(...emit([`buf[offset++] = ${item} ? 1 : 0;`]));
    } else if (wireType === WireType.Varint) {
        if (typeName.endsWith('_64')) {
            const normalized =
                typeName === 'sint_64'
                    ? `__zigZagEncode64(${item})`
                    : `BigInt.asUintN(64, ${item})`;
            size.push(...emit([`size += ${tag} + __varint64Size(${normalized});`]));
            write.push(...emit([`offset = __writeVarint64(buf, offset, ${normalized});`]));
        } else {
            // Preserve QQ's established five-byte negative int32 encoding. Decoders
            // also accept the canonical sign-extended ten-byte representation.
            const normalized =
                typeName === 'sint_32'
                    ? `((${item} << 1) ^ (${item} >> 31)) >>> 0`
                    : `${item} >>> 0`;
            size.push(
                ...emit([`const _val = ${normalized};`, `size += ${tag};`]),
                varintSize('_val', indent),
            );
            write.push(writeVarint(normalized, indent));
        }
    } else {
        size.push(...emit([`size += ${tag + (wireType === WireType.Bit32 ? 4 : 8)};`]));

        if (typeName === 'float' || typeName === 'double') {
            write.push(
                ...emit([
                    `offset = __writeFloat${typeName === 'float' ? 32 : 64}(buf, offset, ${item});`,
                ]),
            );
        } else if (wireType === WireType.Bit64) {
            write.push(...emit([`offset = __writeFixed64(buf, offset, ${item});`]));
        } else {
            write.push(
                ...emit([
                    `const _val = ${item};`,
                    ...[0, 8, 16, 24].map((shift) => `buf[offset++] = (_val >>> ${shift}) & 0xff;`),
                ]),
            );
        }
    }

    return {
        declare,
        size: [...start, ...setup, ...loop, ...size, ...end],
        write: [...start, ...loop, ...write, ...end],
    };
}

function presence(field: ProtobufField, value: string): string {
    // TypeScript optionality controls missing decoded values, not wire presence.
    if (field.explicitPresence || field.isMessage) {
        return `${value} != null`;
    }

    if (field.typeName === 'bool') {
        return `${value} === true`;
    }

    if (field.typeName === 'bytes') {
        return `${value} != null && ${value}.length > 0`;
    }

    const empty = field.typeName === 'string' ? '""' : field.typeName.endsWith('_64') ? '0n' : '0';
    return `${value} != null && ${value} !== ${empty}`;
}
