import { WireType, type MessageRegistry, type ProtobufMessage } from './model.js';
import { generateEncoder, generateEncoderHelpers } from './encoder.js';
import { generateDecoder } from './decoder.js';
import { collectDependencyClosure } from '../codegen/dependencies.js';

import { helpers } from './helpers.js';

/**
 * Generate fully self-contained encode/decode source code.
 * No runtime imports needed — all wire-format logic is inlined.
 */
export interface CodegenOptions {
    encodeRoots?: Iterable<string>;
    decodeRoots?: Iterable<string>;
}

export function generateCode(registry: MessageRegistry, options: CodegenOptions = {}): string {
    if (registry.size === 0) {
        return '';
    }

    const encodeRoots = new Set(options.encodeRoots ?? registry.keys());
    const decodeNames = collectDependencyClosure(registry, options.decodeRoots ?? registry.keys());
    const nestedRoots = [...encodeRoots].filter((name) =>
        registry.get(name)?.fields.some((field) => field.isMessage),
    );
    const encoderHelpers = collectDependencyClosure(registry, nestedRoots);
    const bounds = new Map<string, number>();

    function sizeBound(message: ProtobufMessage): number {
        const cached = bounds.get(message.name);

        if (cached !== undefined) {
            return cached;
        }

        bounds.set(message.name, Infinity);
        let size = 0;

        for (const field of message.fields) {
            if (field.isRepeated || (!field.isMessage && field.wireType === WireType.LengthDelim)) {
                return Infinity;
            }

            // A scalar needs at most 5 tag bytes and 10 payload bytes.
            size += 16;

            if (field.isMessage) {
                size += sizeBound(registry.get(field.typeName)!);
            }

            if (size > 64) {
                return Infinity;
            }
        }

        bounds.set(message.name, size);
        return size;
    }

    const parts: string[] = [];

    for (const msg of registry.values()) {
        if (encodeRoots.has(msg.name)) {
            parts.push(generateEncoder(msg, sizeBound(msg) > 64));
        }

        if (encoderHelpers.has(msg.name)) {
            parts.push(generateEncoderHelpers(msg));
        }

        if (decodeNames.has(msg.name)) {
            parts.push(generateDecoder(msg));
        }
    }

    const body = parts.join('\n');
    const selected = new Set<string>();

    function include(text: string): void {
        for (const match of text.matchAll(/\b__\w+/g)) {
            const name = match[0];

            if (selected.has(name) || !helpers.has(name)) {
                continue;
            }

            selected.add(name);
            include(helpers.get(name)!);
        }
    }

    include(body);
    return [...helpers]
        .filter(([name]) => selected.has(name))
        .map(([, text]) => text)
        .concat(body)
        .join('\n');
}
