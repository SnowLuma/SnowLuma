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
  /**
   * Explicit presence (proto3 `optional`), set only by the `pb_optional<>`
   * marker. When true, a scalar field serialises even at its zero/default
   * value. Distinct from `isOptional` (which merely tracks the TS `?` and is
   * true for almost every field) — the encoder keys off THIS flag, never
   * `isOptional`, so existing `pb<>` fields are unaffected.
   */
  explicitPresence: boolean;
}

export interface ProtobufMessage {
  name: string;
  fields: ProtobufField[];
}

/** Generic interface template, e.g. `interface Wrapper<T> { val: pb<1, T>; }` */
export interface GenericProtobufTemplate {
  name: string;
  typeParams: string[];
  fields: GenericFieldTemplate[];
}

export interface GenericFieldTemplate {
  name: string;
  fieldNumber: number;
  rawTypeName: string;
  isTypeParam: boolean;
  isOptional: boolean;
  isRepeated: boolean;
  /** Explicit presence (proto3 `optional`); see ProtobufField.explicitPresence. */
  explicitPresence: boolean;
  /**
   * For fields whose type-arg is itself a generic instantiation
   * (e.g. `wrapped: pb<5, Wrapper<U>>` where `U` is a template type
   * parameter), the original type-arg source text. At monomorphization
   * time the substituted text is re-parsed and re-instantiated so
   * `Wrapper<uint_32>` ends up in the registry under its mangled name.
   */
  genericTypeArgText?: string;
  /** Source-file path captured alongside `genericTypeArgText`, used as
   *  the synthetic file name when re-parsing the substituted text. */
  genericTypeArgSourceFilePath?: string;
}

export type MessageRegistry = Map<string, ProtobufMessage>;

export const PRIMITIVE_TYPE_MAP: Record<string, { wireType: WireType; defaultValue: string }> = {
  uint_32: { wireType: WireType.Varint, defaultValue: '0' },
  int_32: { wireType: WireType.Varint, defaultValue: '0' },
  uint_64: { wireType: WireType.Varint, defaultValue: '0' },
  int_64: { wireType: WireType.Varint, defaultValue: '0' },
  sint_32: { wireType: WireType.Varint, defaultValue: '0' },
  sint_64: { wireType: WireType.Varint, defaultValue: '0' },
  bool: { wireType: WireType.Varint, defaultValue: 'false' },
  string: { wireType: WireType.LengthDelim, defaultValue: '""' },
  bytes: { wireType: WireType.LengthDelim, defaultValue: 'new Uint8Array(0)' },
  float: { wireType: WireType.Bit32, defaultValue: '0' },
  double: { wireType: WireType.Bit64, defaultValue: '0' },
  fixed_32: { wireType: WireType.Bit32, defaultValue: '0' },
  fixed_64: { wireType: WireType.Bit64, defaultValue: '0' },
  sfixed_32: { wireType: WireType.Bit32, defaultValue: '0' },
  sfixed_64: { wireType: WireType.Bit64, defaultValue: '0' },
};

/** Marker identifiers recognised in type references */
export const PB_MARKER = 'pb';
export const PB_REPEATED_MARKER = 'pb_repeated';
export const PB_OPTIONAL_MARKER = 'pb_optional';
