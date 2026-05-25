// ── Protobuf field markers ────────────────────────────────────────────
/** Marks a singular protobuf field: `name: pb<fieldNumber, Type>` */
export type pb<_ProtoNumber extends number, Type> = Type;
/** Marks a repeated protobuf field: `ids: pb_repeated<fieldNumber, Type>` → Type[] */
export type pb_repeated<_ProtoNumber extends number, Type> = Type[];

// ── Protobuf primitive types ──────────────────────────────────────────
export type uint_32 = number;
export type int_32 = number;
export type uint_64 = bigint;
export type int_64 = bigint;
export type sint_32 = number;
export type sint_64 = bigint;
export type bool = boolean;
export type float = number;
export type double = number;
export type fixed_32 = number;
export type fixed_64 = bigint;
export type sfixed_32 = number;
export type sfixed_64 = bigint;
export type bytes = Uint8Array;

// ── Encode / decode (replaced at compile-time by the vite plugin) ────
export function protobuf_encode<T>(params: T): Uint8Array;
export function protobuf_decode<T>(data: Uint8Array): T;
