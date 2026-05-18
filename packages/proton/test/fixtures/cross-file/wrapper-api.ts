import { protobuf_encode, protobuf_decode } from '@snowluma/proton';

export function encodeViaWrapper<T>(value: T): Uint8Array {
    return protobuf_encode<T>(value);
}

export function decodeViaWrapper<T>(data: Uint8Array): T {
    return protobuf_decode<T>(data);
}

export const encodeArrowWrapper = <T>(value: T): Uint8Array => protobuf_encode<T>(value);

export const decodeArrowWrapper = <T>(data: Uint8Array): T => protobuf_decode<T>(data);

export function encodeSecondGeneric<Ignored, T>(_ignored: Ignored, value: T): Uint8Array {
    return protobuf_encode<T>(value);
}

export function passthroughOnly<T>(value: T): T {
    return value;
}

export const wrapperObject = {
    encode<T>(value: T): Uint8Array {
        return protobuf_encode<T>(value);
    },
    decode<T>(data: Uint8Array): T {
        return protobuf_decode<T>(data);
    },
    encodeArrow: <T>(value: T): Uint8Array => protobuf_encode<T>(value),
};

export function encodeWithBranch<T>(value: T, enabled: boolean): Uint8Array {
    if (enabled) {
        return protobuf_encode<T>(value);
    }
    return protobuf_encode<T>(value);
}

export function encodeWithNestedHelper<T>(value: T): Uint8Array {
    function inner(payload: T): Uint8Array {
        return protobuf_encode<T>(payload);
    }
    return inner(value);
}

export function encodeChained<T>(value: T): Uint8Array {
    return encodeViaWrapper<T>(value);
}