// ── Protobuf field markers ────────────────────────────────────────────
/** Marks a singular protobuf field: `name: pb<fieldNumber, Type>` */
export type pb<_ProtoNumber extends number, Type> = Type;
/** Marks a repeated protobuf field: `ids: pb_repeated<fieldNumber, Type>` → Type[] */
export type pb_repeated<_ProtoNumber extends number, Type> = Type[];
/**
 * Marks a singular field with **explicit presence** (proto3 `optional`): it
 * serialises whenever the value is present, INCLUDING its zero/default value
 * — unlike `pb<>`, which omits zeros. Use when the wire peer needs the field
 * present to disambiguate, e.g. an OIDB sub-command keyed on body shape where
 * a zero must still appear on the wire. `name: pb_optional<fieldNumber, Type>`.
 */
export type pb_optional<_ProtoNumber extends number, Type> = Type;

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

// ── Optional runtime map fallback (disabled by default) ───────────────
export interface ProtobufRuntimeField {
	name: string;
	fieldNumber: number;
	typeName: string;
	wireType: 0 | 1 | 2 | 5;
	isMessage: boolean;
	isOptional: boolean;
	isRepeated: boolean;
}

export interface ProtobufRuntimeMessage {
	name: string;
	fields: ProtobufRuntimeField[];
}

export interface ProtobufRuntimeCallSite {
	file: string;
	line: number;
	column: number;
	fnName: 'protobuf_encode' | 'protobuf_decode';
	typeName: string;
}

export interface ProtobufRuntimeMap {
	version: 1;
	messages: ProtobufRuntimeMessage[];
	callSites: ProtobufRuntimeCallSite[];
}

/** Enables map-based runtime dynamic code generation fallback. */
export function protobuf_enableRuntimeMapFallback(map: ProtobufRuntimeMap): void;

/** Disables map-based runtime fallback and clears generated function cache. */
export function protobuf_disableRuntimeMapFallback(): void;
