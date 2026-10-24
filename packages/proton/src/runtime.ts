import { packageName } from './package.js';

function uncompiled(operation: string): never {
    throw new Error(
        `${operation}<T>() was not transformed by the ${packageName} Vite plugin. Add the plugin from ${packageName}/vite to your build.`,
    );
}

export function protobuf_encode<T>(_value: T): Uint8Array {
    return uncompiled('protobuf_encode');
}

export function protobuf_decode<T>(_bytes: Uint8Array): T {
    return uncompiled('protobuf_decode');
}

export interface ProtobufUnknownField {
    fieldNumber: number;
    wireType: number;
    count: number;
    totalByteLength: number;
}

export interface ProtobufUnknownFieldMetadata {
    fields: readonly ProtobufUnknownField[];
    totalOccurrences: number;
    omittedOccurrences: number;
    omittedByteLength: number;
}

const PROTOBUF_UNKNOWN_FIELDS = Symbol.for('snowluma.proton.unknownFields');
const EMPTY_UNKNOWN_FIELD_METADATA: ProtobufUnknownFieldMetadata = Object.freeze({
    fields: Object.freeze([]),
    totalOccurrences: 0,
    omittedOccurrences: 0,
    omittedByteLength: 0,
});

/** Unknown wire tags retained by generated decoders. The symbol-backed
 * metadata is non-enumerable, so decoded object shapes and re-encoding remain
 * unchanged while protocol boundaries can make schema drift observable. */
export function protobuf_getUnknownFields(value: unknown): readonly ProtobufUnknownField[] {
    return protobuf_getUnknownFieldMetadata(value).fields;
}

export function protobuf_getUnknownFieldMetadata(value: unknown): ProtobufUnknownFieldMetadata {
    if (typeof value !== 'object' || value === null) {
        return EMPTY_UNKNOWN_FIELD_METADATA;
    }

    const metadata = (value as Record<PropertyKey, unknown>)[PROTOBUF_UNKNOWN_FIELDS];

    if (typeof metadata !== 'object' || metadata === null) {
        return EMPTY_UNKNOWN_FIELD_METADATA;
    }

    const candidate = metadata as Partial<ProtobufUnknownFieldMetadata>;

    if (!Array.isArray(candidate.fields)) {
        return EMPTY_UNKNOWN_FIELD_METADATA;
    }

    return {
        fields: candidate.fields,
        totalOccurrences: candidate.totalOccurrences ?? candidate.fields.length,
        omittedOccurrences: candidate.omittedOccurrences ?? 0,
        omittedByteLength: candidate.omittedByteLength ?? 0,
    };
}
