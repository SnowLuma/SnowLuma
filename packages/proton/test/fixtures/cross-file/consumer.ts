import type { UserMsg } from './types';

const buf = protobuf_encode<UserMsg>({ id: 42, name: 'alice' });
const decoded = protobuf_decode<UserMsg>(buf);

export { };
