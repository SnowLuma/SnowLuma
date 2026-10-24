import { describe, it, expect } from 'vitest';
import { schemaRegistry } from '../schema';
import { generateCode } from '../../../src/codegen/generator';
const simple = 'interface SimpleMsg { value: pb<1, uint_32>; }';
const nested =
    'interface Inner { value: pb<1, uint_32>; } interface Outer { inner: pb<1, Inner>; }';
const string = 'interface StringMsg { text: pb<1, string>; }';
const bool = 'interface BoolMsg { active: pb<1, bool>; }';
const repeated =
    'interface RepeatedMsg { ids: pb_repeated<1, uint_32>; names: pb_repeated<2, string>; }';

function makeRoundTrip(schema: string, msgName: string) {
    const gen = generateCode(schemaRegistry(schema, `${msgName}.ts`));
    return new Function(
        gen + `\nreturn { enc: protobuf_encode_${msgName}, dec: protobuf_decode_${msgName} };`,
    )() as {
        enc: (obj: any) => Uint8Array;
        dec: (data: Uint8Array) => any;
    };
}

describe('code generator', () => {
    it('allocates one output buffer for nested repeated messages', () => {
        const schema = `interface Leaf { text: pb<1,string>; } interface Msg { children: pb_repeated<1,Leaf>; }`;
        const registry = schemaRegistry(schema, 'allocation.ts');
        const code = generateCode(registry, { encodeRoots: ['Msg'], decodeRoots: [] });
        let allocations = 0;
        class CountingBytes extends Uint8Array {
            constructor(size: number) {
                super(size);
                allocations++;
            }
            static get [Symbol.species]() {
                return Uint8Array;
            }
        }
        const encode = new Function('Uint8Array', code + '\nreturn protobuf_encode_Msg;')(
            CountingBytes,
        );
        const input = { children: Array.from({ length: 32 }, (_, i) => ({ text: '你好' + i })) };
        const encoded = encode(input);
        expect(allocations).toBe(1);
        expect(makeRoundTrip(schema, 'Msg').dec(encoded)).toEqual(input);
    });

    it('omits unused helpers and decoder functions from encode-only output', () => {
        const code = generateCode(
            schemaRegistry('interface Msg { value: pb<1,uint_32>; }', 'minimal.ts'),
            {
                encodeRoots: ['Msg'],
                decodeRoots: [],
            },
        );
        expect(code).not.toContain('TextDecoder');
        expect(code).not.toContain('TextEncoder');
        expect(code).not.toContain('DataView');
        expect(code).not.toContain('BigInt');
        expect(code).not.toContain('protobuf_decode_');
    });

    it('round-trips a deep mixture of strings and nested messages', () => {
        const schema = Array.from(
            { length: 24 },
            (_, i) =>
                `interface M${i} { text: pb<1,string>; ${i < 23 ? `next: pb<2,M${i + 1}>;` : ''} }`,
        ).join('\n');
        let input: any = { text: 'end' };

        for (let i = 22; i >= 0; i--) {
            input = { text: 'level' + i, next: input };
        }

        const { enc, dec } = makeRoundTrip(schema, 'M0');
        expect(dec(enc(input))).toEqual(input);
    });
    it('round-trips int_32 and preserves five-byte negative varints', () => {
        const { enc, dec } = makeRoundTrip(
            `interface IntMsg {
      value: pb<1, int_32>;
      values: pb_repeated<2, int_32>;
    }`,
            'IntMsg',
        );
        expect([...enc({ value: -1 })]).toEqual([0x08, 0xff, 0xff, 0xff, 0xff, 0x0f]);
        const input = { value: -2147483648, values: [-1, -2147483648, 0, 2147483647] };
        expect(dec(enc(input))).toEqual(input);
    });

    it('preserves fixed_32 unsigned values and sfixed_32 signed values', () => {
        const { enc, dec } = makeRoundTrip(
            `interface FixedMsg {
      unsigned: pb<1, fixed_32>;
      signed: pb<2, sfixed_32>;
      values: pb_repeated<3, fixed_32>;
    }`,
            'FixedMsg',
        );
        const input = {
            unsigned: 0xffffffff,
            signed: -2147483648,
            values: [0x80000000, 0xffffffff],
        };
        expect(dec(enc(input))).toEqual(input);
    });

    it('uses bigint defaults for all 64-bit integer fields', () => {
        const { enc, dec } = makeRoundTrip(
            `interface Defaults {
      unsigned: pb<1, uint_64>;
      signed: pb<2, int_64>;
      zigzag: pb<3, sint_64>;
      fixed: pb<4, fixed_64>;
      sfixed: pb<5, sfixed_64>;
    }`,
            'Defaults',
        );
        const result = dec(new Uint8Array());
        expect(result).toEqual({ unsigned: 0n, signed: 0n, zigzag: 0n, fixed: 0n, sfixed: 0n });
        expect(enc(result)).toEqual(new Uint8Array());
    });

    it('decodes tags with the highest valid field number', () => {
        const { enc, dec } = makeRoundTrip(
            'interface HighTag { value: pb<536870911, uint_32>; }',
            'HighTag',
        );
        const bytes = new Uint8Array([0xf8, 0xff, 0xff, 0xff, 0x0f, 7]);
        expect(enc({ value: 7 })).toEqual(bytes);
        expect(dec(bytes)).toEqual({ value: 7 });
    });

    it('generates encode/decode for simple uint_32', () => {
        const gen = generateCode(schemaRegistry(simple, 't.ts'));
        expect(gen).toContain('function protobuf_encode_SimpleMsg(obj)');
        expect(gen).toContain('function protobuf_decode_SimpleMsg(data');
        // Tag for field 1, varint should be pre-computed as 0x08
        expect(gen).toContain('buf[offset++] = 8;');
    });

    it('generates nested message code', () => {
        const gen = generateCode(schemaRegistry(nested, 't.ts'));
        expect(gen).toContain('protobuf_encode_Inner(');
        expect(gen).toContain('protobuf_decode_Inner(data, offset, offset + _len)');
    });

    it('round-trip uint_32', () => {
        const { enc, dec } = makeRoundTrip(simple, 'SimpleMsg');
        expect(dec(enc({ value: 42 })).value).toBe(42);
    });

    it('round-trip nested message', () => {
        const { enc, dec } = makeRoundTrip(nested, 'Outer');
        expect(dec(enc({ inner: { value: 999 } })).inner.value).toBe(999);
    });

    it('round-trip string', () => {
        const { enc, dec } = makeRoundTrip(string, 'StringMsg');
        expect(dec(enc({ text: 'hello world' })).text).toBe('hello world');
    });

    it('round-trip unicode string', () => {
        const { enc, dec } = makeRoundTrip(string, 'StringMsg');
        expect(dec(enc({ text: '你好，protobuf🚀' })).text).toBe('你好，protobuf🚀');
    });

    it('round-trip bool', () => {
        const { enc, dec } = makeRoundTrip(bool, 'BoolMsg');
        expect(dec(enc({ active: true })).active).toBe(true);
        const empty = enc({ active: false });
        expect(empty.length).toBe(0);
        expect(dec(empty).active).toBe(false);
    });

    it('proto3 default encoding (0 → empty)', () => {
        const { enc } = makeRoundTrip(simple, 'SimpleMsg');
        expect(enc({ value: 0 }).length).toBe(0);
    });

    it('round-trip repeated uint_32', () => {
        const { enc, dec } = makeRoundTrip(repeated, 'RepeatedMsg');
        const result = dec(enc({ ids: [10, 20, 30], names: [] }));
        expect(result.ids).toEqual([10, 20, 30]);
        expect(result.names).toEqual([]);
    });

    it('round-trip repeated string', () => {
        const { enc, dec } = makeRoundTrip(repeated, 'RepeatedMsg');
        const result = dec(enc({ ids: [], names: ['hello', 'world'] }));
        expect(result.ids).toEqual([]);
        expect(result.names).toEqual(['hello', 'world']);
    });

    it('repeated empty arrays round-trip', () => {
        const { enc, dec } = makeRoundTrip(repeated, 'RepeatedMsg');
        const result = dec(enc({ ids: [], names: [] }));
        expect(result.ids).toEqual([]);
        expect(result.names).toEqual([]);
    });

    it('round-trip bigint-backed 64-bit integers', () => {
        const schema = `
interface BigIntMsg {
  unsigned: pb<1, uint_64>;
  signed: pb<2, int_64>;
  zigzag: pb<3, sint_64>;
  fixed: pb<4, fixed_64>;
  sfixed: pb<5, sfixed_64>;
  ids: pb_repeated<6, uint_64>;
}`;
        const { enc, dec } = makeRoundTrip(schema, 'BigIntMsg');
        const input = {
            unsigned: 18446744073709551615n,
            signed: -1n,
            zigzag: -1234567890123456789n,
            fixed: 0x0102030405060708n,
            sfixed: -0x0102030405060708n,
            ids: [1n, 2n, 9007199254740993n],
        };
        expect(dec(enc(input))).toEqual(input);
    });

    it('round-trip sint_32 with negative values', () => {
        const schema = `
interface Sint32Msg {
  value: pb<1, sint_32>;
  values: pb_repeated<2, sint_32>;
}`;
        const { enc, dec } = makeRoundTrip(schema, 'Sint32Msg');
        const input = { value: -789, values: [-1, 0, 1, -789, 2147483647, -2147483648] };
        expect(dec(enc(input))).toEqual(input);
    });

    it('round-trip double as ieee754 number', () => {
        const schema = `
interface DoubleMsg {
  value: pb<1, double>;
  values: pb_repeated<2, double>;
}`;
        const { enc, dec } = makeRoundTrip(schema, 'DoubleMsg');
        const result = dec(enc({ value: Math.PI, values: [Math.E, -0.5] }));
        expect(result.value).toBeCloseTo(Math.PI);
        expect(result.values[0]).toBeCloseTo(Math.E);
        expect(result.values[1]).toBeCloseTo(-0.5);
    });
});
