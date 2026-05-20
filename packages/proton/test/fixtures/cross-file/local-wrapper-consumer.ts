import type { Wrapper } from './generic-types';
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';

function localEncode<T>(value: T): Uint8Array {
    return protobuf_encode<T>(value);
}

const buf = localEncode<Wrapper<string>>({ value: 'local' });
const decoded = protobuf_decode<Wrapper<string>>(buf);

export { };