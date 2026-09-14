import { describe, it, expect } from 'vitest';
import { analyzeSource } from '../../src/ast/analyzer';
import { generateCode } from '../../src/codegen/generator';
import { protobuf_getUnknownFieldMetadata } from '../../src/runtime';
import { loadFixture } from '../helpers';

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

function encodeVarint32(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
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
    expect(gen).toContain('protobuf_decode_Inner(data, offset, _end)');
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

  it('preserves legacy outbound int_32 bytes while accepting canonical negative varints', () => {
    const schema = `
interface Int32Msg {
  value: pb<1, int_32>;
  values: pb_repeated<2, int_32>;
  forced: pb_optional<3, int_32>;
}`;
    const { enc, dec } = makeRoundTripFromSchema(schema, 'Int32Msg');
    const input = {
      value: -1,
      values: [-2147483648, -1, 0, 1, 2147483647],
      forced: -2147483648,
    };
    const encoded = enc(input);

    // Keep SnowLuma's established five-byte negative int32 encoding on the
    // outbound path until QQ interoperability is verified on a live account.
    // The decoder remains liberal and accepts protobuf's canonical ten-byte
    // negative form below.
    expect(Array.from(encoded.slice(0, 6))).toEqual([
      0x08,
      0xff, 0xff, 0xff, 0xff, 0x0f,
    ]);
    expect(dec(encoded)).toEqual(input);
    expect(dec(Uint8Array.from([
      0x08,
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    ])).value).toBe(-1);
  });

  it('retains the low 32 bits of extended uint_32 field varints', () => {
    const { dec } = makeRoundTripFromSchema(
      `interface Uint32Msg { value: pb<1, uint_32>; }`,
      'Uint32Msg',
    );

    // QQ sometimes serializes a signed 32-bit source into a schema slot that
    // clients expose as uint32. Protobuf readers consume the full ten-byte
    // varint and retain its low 32 bits for wire compatibility.
    expect(dec(Uint8Array.from([
      0x08,
      0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    ])).value).toBe(0xfffffffe);

    // QQ-compatible uint32 readers consume up to a full 64-bit varint and
    // retain its low 32 bits. Some push-envelope sequences use that wire
    // representation, so values with non-zero high bits must remain decodable.
    expect(dec(Uint8Array.from([
      0x08,
      0x80, 0x80, 0x80, 0x80, 0x10,
    ])).value).toBe(0);
    expect(dec(Uint8Array.from([
      0x08,
      0x87, 0x80, 0x80, 0x80, 0x10,
    ])).value).toBe(7);

    // Compatibility applies only to complete uint64 varints. Truncated input
    // and values wider than 64 bits must still fail loudly.
    expect(() => dec(Uint8Array.from([
      0x08,
      0x80,
    ]))).toThrow(/truncated uint64 varint/);
    expect(() => dec(Uint8Array.from([
      0x08,
      0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02,
    ]))).toThrow(/uint64 varint overflow/);
  });

  it('rejects malformed length-delimited fields without leaving parent bounds', () => {
    const schema = `interface BytesMsg { data: pb<1, bytes>; }`;
    const gen = generateCode(analyzeSource(schema, 'BytesMsg.ts'));
    const { dec } = makeRoundTripFromSchema(schema, 'BytesMsg');

    expect(gen).toContain('const _end = __checkedEnd(offset, _len, end);');
    expect(() => dec(Uint8Array.from([0x0a, 0x80]))).toThrow(/truncated uint32 varint/);
    expect(() => dec(Uint8Array.from([0x0a, 0x80, 0x80, 0x80, 0x80, 0x10]))).toThrow(/uint32 varint overflow/);
  });

  it('skips unknown groups without decoding their fields into the parent', () => {
    const schema = `
interface Text { str: pb<1, string>; }
interface Elem { text: pb<1, Text>; }
`;
    const { dec } = makeRoundTripFromSchema(schema, 'Elem');
    const decoded = dec(Uint8Array.from([
      0x7b,
      0x0a, 0x08, 0x0a, 0x06, 0x66, 0x6f, 0x72, 0x67, 0x65, 0x64,
      0x7c,
    ]));

    expect(decoded.text).toBeNull();
    expect(protobuf_getUnknownFieldMetadata(decoded).fields).toMatchObject([
      { fieldNumber: 15, wireType: 3 },
    ]);
  });

  it('aggregates repeated unknown fields instead of retaining every occurrence', () => {
    const { dec } = makeRoundTripFromSchema(
      `interface UnknownMsg { known: pb<1, uint_32>; }`,
      'UnknownMsg',
    );
    const wire: number[] = [];
    const tag = encodeVarint32((60 << 3) | 0);
    for (let index = 0; index < 1_000; index++) wire.push(...tag, 0);

    const metadata = protobuf_getUnknownFieldMetadata(dec(Uint8Array.from(wire)));
    expect(metadata).toEqual({
      fields: [{ fieldNumber: 60, wireType: 0, count: 1_000, totalByteLength: 1_000 }],
      totalOccurrences: 1_000,
      omittedOccurrences: 0,
      omittedByteLength: 0,
    });
  });

  it('caps retained unknown field kinds and summarizes overflow', () => {
    const { dec } = makeRoundTripFromSchema(
      `interface UnknownKindsMsg { known: pb<1, uint_32>; }`,
      'UnknownKindsMsg',
    );
    const wire: number[] = [];
    for (let fieldNumber = 2; fieldNumber <= 66; fieldNumber++) {
      wire.push(...encodeVarint32((fieldNumber << 3) | 0), 0);
    }

    const metadata = protobuf_getUnknownFieldMetadata(dec(Uint8Array.from(wire)));
    expect(metadata.fields).toHaveLength(64);
    expect(metadata.totalOccurrences).toBe(65);
    expect(metadata.omittedOccurrences).toBe(1);
    expect(metadata.omittedByteLength).toBe(1);
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

describe('pb_optional explicit presence', () => {
  it('serialises a zero scalar (where pb<> would omit it)', () => {
    const { enc, dec } = makeRoundTripFromSchema(
      `interface OptMsg { forced: pb_optional<1, uint_32>; }`,
      'OptMsg',
    );
    // field 1, varint, value 0 → tag 0x08 then payload 0x00 (NOT empty).
    expect(Array.from(enc({ forced: 0 }))).toEqual([0x08, 0x00]);
    expect(dec(enc({ forced: 0 })).forced).toBe(0);
  });

  it('still omits the field when the value is absent (undefined)', () => {
    const { enc } = makeRoundTripFromSchema(
      `interface OptMsg2 { forced: pb_optional<1, uint_32>; }`,
      'OptMsg2',
    );
    expect(enc({}).length).toBe(0);
  });

  it('does not change a sibling plain pb<> field (it still omits its zero)', () => {
    const { enc, dec } = makeRoundTripFromSchema(
      `interface MixMsg { plain: pb<1, uint_32>; forced: pb_optional<2, uint_32>; }`,
      'MixMsg',
    );
    // plain=0 omitted (unchanged); only forced=0 is emitted (field 2 → tag 0x10).
    expect(Array.from(enc({ plain: 0, forced: 0 }))).toEqual([0x10, 0x00]);
    expect(dec(enc({ plain: 7, forced: 9 }))).toEqual({ plain: 7, forced: 9 });
  });

  it('forces a false bool onto the wire', () => {
    const { enc, dec } = makeRoundTripFromSchema(
      `interface BoolOpt { flag: pb_optional<1, bool>; }`,
      'BoolOpt',
    );
    expect(Array.from(enc({ flag: false }))).toEqual([0x08, 0x00]);
    expect(dec(enc({ flag: false })).flag).toBe(false);
    expect(Array.from(enc({ flag: true }))).toEqual([0x08, 0x01]);
  });
});
