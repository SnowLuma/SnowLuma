import {
    encodeBoxed,
    decodeBoxed,
    encodeAliasBoxed,
    encodeNestedBoxed,
    encodeBoxedChain,
} from './wrapper-type-source';

const boxedBuf = encodeBoxed<string>({ value: 'boxed' });
const boxedDecoded = decodeBoxed<string>(boxedBuf);
const aliasBuf = encodeAliasBoxed<string>({ value: 'alias' });
const nestedBuf = encodeNestedBoxed<string>({ value: { value: 'nested' } });
const chainedBuf = encodeBoxedChain<string>({ value: 'chain' });

export { };