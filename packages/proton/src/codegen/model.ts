export enum WireType {
    Varint = 0,
    Bit64 = 1,
    LengthDelim = 2,
    Bit32 = 5,
}

export interface ProtobufField {
    name: string;
    fieldNumber: number;
    typeName: string;
    wireType: WireType;
    isMessage: boolean;
    isOptional: boolean;
    isRepeated: boolean;
    explicitPresence?: boolean;
}

export interface ProtobufMessage {
    name: string;
    fields: ProtobufField[];
}

export type MessageRegistry = Map<string, ProtobufMessage>;

export const PRIMITIVE_TYPE_MAP: Record<string, { wireType: WireType; defaultValue: string }> = {
    uint_32: { wireType: WireType.Varint, defaultValue: '0' },
    int_32: { wireType: WireType.Varint, defaultValue: '0' },
    uint_64: { wireType: WireType.Varint, defaultValue: '0n' },
    int_64: { wireType: WireType.Varint, defaultValue: '0n' },
    sint_32: { wireType: WireType.Varint, defaultValue: '0' },
    sint_64: { wireType: WireType.Varint, defaultValue: '0n' },
    bool: { wireType: WireType.Varint, defaultValue: 'false' },
    string: { wireType: WireType.LengthDelim, defaultValue: '""' },
    bytes: { wireType: WireType.LengthDelim, defaultValue: 'new Uint8Array(0)' },
    float: { wireType: WireType.Bit32, defaultValue: '0' },
    double: { wireType: WireType.Bit64, defaultValue: '0' },
    fixed_32: { wireType: WireType.Bit32, defaultValue: '0' },
    fixed_64: { wireType: WireType.Bit64, defaultValue: '0n' },
    sfixed_32: { wireType: WireType.Bit32, defaultValue: '0' },
    sfixed_64: { wireType: WireType.Bit64, defaultValue: '0n' },
};
