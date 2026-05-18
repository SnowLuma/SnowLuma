import type { Inner } from './inner';

interface Outer {
    inner: pb<1, Inner>;
}

const buf = protobuf_encode<Outer>({ inner: { value: 42 } });
const decoded = protobuf_decode<Outer>(buf);

export { };
