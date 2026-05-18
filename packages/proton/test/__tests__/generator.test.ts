import { describe, it, expect } from 'vitest';
import { analyzeSource } from '../../src/ast/analyzer';
import { generateCode } from '../../src/codegen/generator';
import { loadFixture, execAndGet } from '../helpers';

/** Analyze fixture → generate → eval → return encode/decode pair */
function makeRoundTrip(fixtureName: string, msgName: string) {
  const gen = generateCode(analyzeSource(loadFixture(fixtureName), fixtureName));
  new Function(gen + `\nglobalThis.__enc = protobuf_encode_${msgName}; globalThis.__dec = protobuf_decode_${msgName};`)();
  const enc = (globalThis as any).__enc as (obj: any) => Uint8Array;
  const dec = (globalThis as any).__dec as (data: Uint8Array) => any;
  delete (globalThis as any).__enc;
  delete (globalThis as any).__dec;
  return { enc, dec };
}

function makeRoundTripFromSchema(schema: string, msgName: string) {
  const gen = generateCode(analyzeSource(schema, `${msgName}.ts`));
  new Function(gen + `\nglobalThis.__enc = protobuf_encode_${msgName}; globalThis.__dec = protobuf_decode_${msgName};`)();
  const enc = (globalThis as any).__enc as (obj: any) => Uint8Array;
  const dec = (globalThis as any).__dec as (data: Uint8Array) => any;
  delete (globalThis as any).__enc;
  delete (globalThis as any).__dec;
  return { enc, dec };
}

describe('code generator', () => {
  it('generates encode/decode for simple uint_32', () => {
    const gen = generateCode(analyzeSource(loadFixture('simple.ts'), 't.ts'));
    expect(gen).toContain('function protobuf_encode_SimpleMsg(obj)');
    expect(gen).toContain('function protobuf_decode_SimpleMsg(data');
    // Tag for field 1, varint should be pre-computed as 0x08
    expect(gen).toContain('buf[offset++] = 8;');
  });

  it('generates nested message code', () => {
    const gen = generateCode(analyzeSource(loadFixture('nested.ts'), 't.ts'));
    expect(gen).toContain('protobuf_encode_Inner(');
    expect(gen).toContain('protobuf_decode_Inner(data, offset, offset + _len)');
  });

  it('round-trip uint_32', () => {
    const { enc, dec } = makeRoundTrip('simple.ts', 'SimpleMsg');
    expect(dec(enc({ value: 42 })).value).toBe(42);
  });

  it('round-trip nested message', () => {
    const { enc, dec } = makeRoundTrip('nested.ts', 'Outer');
    expect(dec(enc({ inner: { value: 999 } })).inner.value).toBe(999);
  });

  it('round-trip string', () => {
    const { enc, dec } = makeRoundTrip('string-msg.ts', 'StringMsg');
    expect(dec(enc({ text: 'hello world' })).text).toBe('hello world');
  });

  it('round-trip unicode string', () => {
    const { enc, dec } = makeRoundTrip('string-msg.ts', 'StringMsg');
    expect(dec(enc({ text: '你好，protobuf🚀' })).text).toBe('你好，protobuf🚀');
  });

  it('round-trip bool', () => {
    const { enc, dec } = makeRoundTrip('bool-msg.ts', 'BoolMsg');
    expect(dec(enc({ active: true })).active).toBe(true);
    const empty = enc({ active: false });
    expect(empty.length).toBe(0);
    expect(dec(empty).active).toBe(false);
  });

  it('proto3 default encoding (0 → empty)', () => {
    const { enc } = makeRoundTrip('simple.ts', 'SimpleMsg');
    expect(enc({ value: 0 }).length).toBe(0);
  });

  it('round-trip repeated uint_32', () => {
    const { enc, dec } = makeRoundTrip('repeated.ts', 'RepeatedMsg');
    const result = dec(enc({ ids: [10, 20, 30], names: [] }));
    expect(result.ids).toEqual([10, 20, 30]);
    expect(result.names).toEqual([]);
  });

  it('round-trip repeated string', () => {
    const { enc, dec } = makeRoundTrip('repeated.ts', 'RepeatedMsg');
    const result = dec(enc({ ids: [], names: ['hello', 'world'] }));
    expect(result.ids).toEqual([]);
    expect(result.names).toEqual(['hello', 'world']);
  });

  it('repeated empty arrays round-trip', () => {
    const { enc, dec } = makeRoundTrip('repeated.ts', 'RepeatedMsg');
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
    const { enc, dec } = makeRoundTripFromSchema(schema, 'BigIntMsg');
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
    const { enc, dec } = makeRoundTripFromSchema(schema, 'Sint32Msg');
    const input = { value: -789, values: [-1, 0, 1, -789, 2147483647, -2147483648] };
    expect(dec(enc(input))).toEqual(input);
  });

  it('round-trip double as ieee754 number', () => {
    const schema = `
interface DoubleMsg {
  value: pb<1, double>;
  values: pb_repeated<2, double>;
}`;
    const { enc, dec } = makeRoundTripFromSchema(schema, 'DoubleMsg');
    const result = dec(enc({ value: Math.PI, values: [Math.E, -0.5] }));
    expect(result.value).toBeCloseTo(Math.PI);
    expect(result.values[0]).toBeCloseTo(Math.E);
    expect(result.values[1]).toBeCloseTo(-0.5);
  });
});
