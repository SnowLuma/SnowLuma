import type { ProtobufMessage } from './model.js';
import { fieldBlock } from './fields.js';

export function generateEncoderHelpers(message: ProtobufMessage): string {
    const blocks = message.fields.map((field, index) => fieldBlock(field, index, true));
    return [
        `function __size_${message.name}(obj, sizes) {`,
        '  let size = 0;',
        ...blocks.flatMap((block) => block.declare),
        ...blocks.flatMap((block) => block.size),
        '  return size;',
        '}',
        `function __write_${message.name}(obj, buf, offset, sizes) {`,
        ...blocks.flatMap((block) => block.declare),
        ...blocks.flatMap((block) => block.write),
        '  return offset;',
        '}',
    ].join('\n');
}

export function generateEncoder(message: ProtobufMessage, pooled = false): string {
    const allocation = pooled
        ? '  const buf = size <= 64 ? new Uint8Array(size) : __allocate(size);'
        : '  const buf = new Uint8Array(size);';

    if (message.fields.some((field) => field.isMessage)) {
        return [
            `function protobuf_encode_${message.name}(obj) {`,
            '  const sizes = [1];',
            ...(pooled
                ? [`  const size = __size_${message.name}(obj, sizes);`, allocation]
                : [`  const buf = new Uint8Array(__size_${message.name}(obj, sizes));`]),
            `  __write_${message.name}(obj, buf, 0, sizes);`,
            '  return buf;',
            '}',
        ].join('\n');
    }

    const blocks = message.fields.map((field, index) => fieldBlock(field, index, false));
    return [
        `function protobuf_encode_${message.name}(obj) {`,
        '  let size = 0;',
        ...blocks.flatMap((block) => block.declare),
        ...blocks.flatMap((block) => block.size),
        allocation,
        '  let offset = 0;',
        ...blocks.flatMap((block) => block.write),
        '  return buf;',
        '}',
    ].join('\n');
}
