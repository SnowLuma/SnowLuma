import type { Wrapper } from './generic-types';
import {
    wrapperObject,
    encodeWithBranch,
    encodeWithNestedHelper,
    encodeChained,
} from './wrapper-api';

const objectBuf = wrapperObject.encode<Wrapper<string>>({ value: 'object' });
const objectDecoded = wrapperObject.decode<Wrapper<string>>(objectBuf);

const arrowMemberBuf = wrapperObject.encodeArrow<Wrapper<Wrapper<string>>>({ value: { value: 'member' } });

const { encodeArrow } = wrapperObject;
const destructuredBuf = encodeArrow<Wrapper<string>>({ value: 'destructured' });

const branchBuf = encodeWithBranch<Wrapper<string>>({ value: 'branch' }, true);
const nestedHelperBuf = encodeWithNestedHelper<Wrapper<string>>({ value: 'nested-helper' });
const chainedBuf = encodeChained<Wrapper<string>>({ value: 'chained' });

export { };