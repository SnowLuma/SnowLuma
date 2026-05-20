import type { Wrapper } from './generic-types';

const buf = protobuf_encode<Wrapper<string>>({ value: 'hello' });
const decoded = protobuf_decode<Wrapper<string>>(buf);

export { };
