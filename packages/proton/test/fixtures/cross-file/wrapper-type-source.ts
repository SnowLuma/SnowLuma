import type { Wrapper } from './generic-types';
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';
import { encodeBoxed as encodeBoxedBase } from './wrapper-type-source-base';

export type AliasWrapper<T> = Wrapper<T>;

export function encodeBoxed<T>(value: Wrapper<T>): Uint8Array {
    return protobuf_encode<Wrapper<T>>(value);
}

export function decodeBoxed<T>(data: Uint8Array): Wrapper<T> {
    return protobuf_decode<Wrapper<T>>(data);
}

export function encodeAliasBoxed<T>(value: AliasWrapper<T>): Uint8Array {
    return protobuf_encode<Wrapper<T>>(value);
}

export function encodeNestedBoxed<T>(value: Wrapper<Wrapper<T>>): Uint8Array {
    return protobuf_encode<Wrapper<Wrapper<T>>>(value);
}

export function encodeBoxedChain<T>(value: Wrapper<T>): Uint8Array {
    return encodeBoxedBase<T>(value);
}