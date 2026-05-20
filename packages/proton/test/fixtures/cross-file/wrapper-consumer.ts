import type { Wrapper } from './generic-types';
import { encodeViaWrapper, decodeViaWrapper } from './wrapper-api';

const buf = encodeViaWrapper<Wrapper<string>>({ value: 'hello' });
const decoded = decodeViaWrapper<Wrapper<string>>(buf);

export { };