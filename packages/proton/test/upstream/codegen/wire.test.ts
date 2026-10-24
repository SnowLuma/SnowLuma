import { describe, it, expect } from 'vitest';
import { schemaCodecs as codecs } from '../schema';

describe('generated wire format', () => {
    it('matches TextEncoder at UTF-8 length-prefix boundaries', () => {
        const codec = codecs<{ value: string }>('interface Msg {value:pb<1,string>;}');

        for (const length of [127, 128, 16383, 16384]) {
            for (const value of ['a'.repeat(length), '界🚀\ud800'.repeat(length)]) {
                const payload = new TextEncoder().encode(value);
                const prefix = [10];
                let remaining = payload.length;

                do {
                    prefix.push((remaining % 128) | (remaining >= 128 ? 128 : 0));
                    remaining = Math.floor(remaining / 128);
                } while (remaining);

                const expected = new Uint8Array(prefix.length + payload.length);
                expected.set(prefix);
                expected.set(payload, prefix.length);
                expect(codec.encode({ value })).toEqual(expected);
                expect(codec.decode(expected)).toEqual({
                    value: new TextDecoder().decode(payload),
                });
            }
        }
    });

    it('decodes floating-point, fixed-width and byte fields from unaligned subarrays', () => {
        const codec = codecs<{ f: number; d: number; fixed: bigint; data: Uint8Array }>(
            `interface Msg {f:pb<1,float>;d:pb<2,double>;fixed:pb<3,fixed_64>;data:pb<4,bytes>;}`,
        );
        const input = {
            f: Math.fround(1 / 3),
            d: -Number.MAX_VALUE,
            fixed: (1n << 64n) - 1n,
            data: new Uint8Array([0, 1, 255]),
        };
        const wire = codec.encode(input);

        for (const padding of [1, 3, 7, 31]) {
            const buffer = new Uint8Array(wire.length + padding + 5).fill(255);
            buffer.set(wire, padding);
            expect(codec.decode(buffer.subarray(padding, padding + wire.length))).toEqual(input);
        }
    });
    it('matches an independent bigint varint reference at every byte boundary', () => {
        const codec = codecs<{ value: bigint }>('interface Msg { value: pb<1, uint_64>; }');
        const values = new Set<bigint>([0n, 1n, (1n << 64n) - 1n]);

        for (let bit = 1n; bit < 64n; bit++) {
            values.add((1n << bit) - 1n);
            values.add(1n << bit);
            values.add((1n << bit) + 1n);
        }

        for (const value of values) {
            let rest = value;
            const bytes = [];

            do {
                bytes.push(Number(rest & 127n) | (rest > 127n ? 128 : 0));
                rest >>= 7n;
            } while (rest);

            const wire = new Uint8Array([8, ...bytes]);
            expect(codec.encode({ value })).toEqual(value === 0n ? new Uint8Array() : wire);
            expect(codec.decode(wire)).toEqual({ value });
        }
    });

    it('decodes nonzero booleans whose low 32 bits are zero', () => {
        const codec = codecs<{ value: boolean }>('interface Msg { value: pb<1, bool>; }');
        expect(codec.decode(new Uint8Array([8, 128, 128, 128, 128, 16]))).toEqual({ value: true });
    });
    const uint32 = codecs<{ value: number }>('interface Msg { value: pb<1, uint_32>; }');
    const varints: [number, number[]][] = [
        [1, [0x01]],
        [127, [0x7f]],
        [128, [0x80, 0x01]],
        [300, [0xac, 0x02]],
        [16384, [0x80, 0x80, 0x01]],
        [0xffffffff, [0xff, 0xff, 0xff, 0xff, 0x0f]],
    ];

    it.each(varints)('encodes uint32 %i using the expected wire bytes', (value, bytes) => {
        expect([...uint32.encode({ value })]).toEqual([0x08, ...bytes]);
    });

    it.each(varints)('decodes uint32 %i from independent wire bytes', (value, bytes) => {
        expect(uint32.decode(new Uint8Array([0x08, ...bytes]))).toEqual({ value });
    });

    it('omits scalar zero and decodes an explicit zero', () => {
        expect(uint32.encode({ value: 0 })).toEqual(new Uint8Array());
        expect(uint32.decode(new Uint8Array([8, 0]))).toEqual({ value: 0 });
    });

    it.each(['hello', '', '你好', '🚀', '\ud800', '\udc00'])('encodes UTF-8 %j', (value) => {
        const codec = codecs<{ value: string }>('interface Msg { value: pb<1, string>; }');
        const payload = new TextEncoder().encode(value);
        const bytes = new Uint8Array([0x0a, payload.length, ...payload]);
        expect(codec.encode({ value })).toEqual(value === '' ? new Uint8Array() : bytes);
        expect(codec.decode(bytes)).toEqual({ value: new TextDecoder().decode(payload) });
    });

    it('encodes bytes with a length prefix and copies the decoded data', () => {
        const codec = codecs<{ value: Uint8Array }>('interface Msg { value: pb<1, bytes>; }');
        const bytes = new Uint8Array([10, 3, 1, 128, 255]);
        const value = new Uint8Array([1, 128, 255]);
        expect(codec.encode({ value })).toEqual(bytes);
        const result = codec.decode(bytes);
        bytes[2] = 0;
        expect(result.value).toEqual(value);
    });

    it.each([
        ['varint', [0x10, 0xac, 0x02]],
        ['64-bit', [0x11, 1, 2, 3, 4, 5, 6, 7, 8]],
        ['length-delimited', [0x12, 3, 0x41, 0x42, 0x43]],
        ['32-bit', [0x15, 1, 2, 3, 4]],
    ])('skips unknown %s fields and resumes decoding', (_name, bytes) => {
        expect(uint32.decode(new Uint8Array([...(bytes as number[]), 8, 7]))).toEqual({ value: 7 });
    });

    const packedCases: [string, (number | bigint | boolean)[], number[]][] = [
        ['uint_32', [1, 300], [1, 0xac, 2]],
        ['int_32', [1, -2], [1, 0xfe, ...Array(8).fill(0xff), 1]],
        ['sint_32', [-1, 1], [1, 2]],
        ['bool', [true, false], [1, 0]],
        ['uint_64', [1n, 300n], [1, 0xac, 2]],
        ['int_64', [1n, -2n], [1, 0xfe, ...Array(8).fill(0xff), 1]],
        ['sint_64', [-1n, 1n], [1, 2]],
        ['fixed_32', [0xffffffff, 1], [255, 255, 255, 255, 1, 0, 0, 0]],
        ['sfixed_32', [-1, 1], [255, 255, 255, 255, 1, 0, 0, 0]],
        ['fixed_64', [1n], [1, 0, 0, 0, 0, 0, 0, 0]],
        ['sfixed_64', [-1n], Array(8).fill(255)],
        ['float', [1], [0, 0, 128, 63]],
        ['double', [1], [0, 0, 0, 0, 0, 0, 240, 63]],
    ];

    it.each(packedCases)(
        'decodes packed, unpacked and split %s arrays',
        (type, values, payload) => {
            const codec = codecs<{ values: typeof values }>(
                `interface Msg { values: pb_repeated<1, ${type}>; }`,
            );
            const packed = [10, payload.length, ...payload];
            const unpacked = codec.encode({ values });
            expect(codec.decode(new Uint8Array(packed))).toEqual({ values });
            expect(codec.decode(new Uint8Array([...packed, ...unpacked, ...packed]))).toEqual({
                values: [...values, ...values, ...values],
            });
            expect(codec.decode(new Uint8Array([10, 0]))).toEqual({ values: [] });
        },
    );

    const malformedCodec = codecs(`
    interface Inner { value: pb<1, uint_32>; }
    interface Msg {
      value: pb<1, uint_32>;
      big: pb<2, uint_64>;
      text: pb<3, string>;
      data: pb<4, bytes>;
      float: pb<5, float>;
      double: pb<6, double>;
      inner: pb<7, Inner>;
      values: pb_repeated<8, uint_32>;
      fixed: pb_repeated<9, fixed_32>;
    }
  `);
    const invalidCases: [string, number[]][] = [
        ['zero tag', [0]],
        ['invalid wire type', [15]],
        ['truncated tag', [128]],
        ['overflowing tag', [255, 255, 255, 255, 31]],
        ['missing varint', [8]],
        ['unterminated varint', [8, 128]],
        ['overflowing varint', [8, ...Array(10).fill(255)]],
        ['truncated bigint', [16, 128]],
        ['overflowing bigint', [16, ...Array(9).fill(255), 2]],
        ['missing string length', [26]],
        ['truncated string', [26, 2, 65]],
        ['overflowing length', [26, 255, 255, 255, 255, 31]],
        ['truncated bytes', [34, 2, 1]],
        ['truncated float', [45, 0]],
        ['truncated double', [49, 0]],
        ['nested message exceeds parent', [58, 5, 8, 1]],
        ['nested varint exceeds nested boundary', [58, 2, 8, 128, 8, 7]],
        ['packed varint exceeds packed boundary', [66, 1, 128, 8, 7]],
        ['packed fixed32 has partial value', [74, 3, 1, 2, 3, 8, 7]],
        ['unknown truncated varint', [80, 128]],
        ['unknown truncated fixed64', [81, 0]],
        ['unknown truncated bytes', [82, 5, 1]],
        ['unknown truncated fixed32', [85, 0]],
    ];

    it.each(invalidCases)('rejects %s', (_name, bytes) => {
        expect(() => malformedCodec.decode(new Uint8Array(bytes))).toThrow(/protobuf/);
    });
});
