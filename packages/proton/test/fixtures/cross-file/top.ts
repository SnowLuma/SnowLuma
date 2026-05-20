import type { Mid } from './mid';

interface Top {
    nested: pb<1, Mid>;
}

const buf = protobuf_encode<Top>({ nested: { inner: { val: 99 } } });
const decoded = protobuf_decode<Top>(buf);

export { };
