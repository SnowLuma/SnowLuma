import type { Wrapper } from './generic-types';
import {
    encodeViaWrapper as encAlias,
    decodeViaWrapper as decAlias,
    encodeArrowWrapper,
    decodeArrowWrapper,
    encodeSecondGeneric,
    passthroughOnly,
} from './wrapper-api';

const aliasBuf = encAlias<Wrapper<string>>({ value: 'alias' });
const aliasDecoded = decAlias<Wrapper<string>>(aliasBuf);

const arrowBuf = encodeArrowWrapper<Wrapper<Wrapper<string>>>({ value: { value: 'nested' } });
const arrowDecoded = decodeArrowWrapper<Wrapper<Wrapper<string>>>(arrowBuf);

const secondBuf = encodeSecondGeneric<number, Wrapper<string>>(1, { value: 'second' });

const passthrough = passthroughOnly<Wrapper<string>>({ value: 'ignored' });

export { };