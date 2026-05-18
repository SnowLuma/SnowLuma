// Aliased import of the pb / pb_repeated markers.
//
// `parsePbTypeRef` compared the literal type-ref identifier text against
// the constants `'pb'` / `'pb_repeated'`. With `import { pb as P }` the
// identifier text becomes `'P'`, so the field was silently dropped from
// the message — interfaces ended up looking empty.
//
// Fix: resolve the marker name through the imported-name resolver before
// comparing.

import type { pb as P, pb_repeated as PR, uint_32 } from '@snowluma/proton';

interface Aliased {
    id:   P<1, uint_32>;
    tags: PR<2, string>;
}

const data = protobuf_encode<Aliased>({ id: 1, tags: ['a', 'b'] });
const decoded = protobuf_decode<Aliased>(data);

export { };
