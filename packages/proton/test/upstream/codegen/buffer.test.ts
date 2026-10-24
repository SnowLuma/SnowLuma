import { describe, expect, it } from 'vitest';
import { schemaCodecs } from '../schema';

const bytesSchema = 'interface Msg { data: pb<1,bytes>; }';

describe('encoded buffers', () => {
    it('round-trips messages around allocation and slab boundaries', () => {
        const codec = schemaCodecs<{ data: Uint8Array }>(bytesSchema);

        for (const length of [
            0, 1, 61, 62, 63, 64, 65, 125, 127, 128, 4092, 4093, 4094, 4095, 4096, 8192,
        ]) {
            const data = Uint8Array.from({ length }, (_, i) => (i * 13) & 255);
            const encoded = codec.encode({ data });
            expect(codec.decode(encoded)).toEqual({ data });

            if (encoded.length <= 64 || encoded.length > 4096) {
                expect(encoded.byteOffset).toBe(0);
                expect(encoded.buffer.byteLength).toBe(encoded.length);
            }
        }
    });

    it('keeps retained results intact across slab rotation and subsequent mutations', () => {
        const codec = schemaCodecs<{ data: Uint8Array }>(bytesSchema);
        const retained = Array.from({ length: 200 }, (_, index) => {
            const data = new Uint8Array([63, 128, 800, 1300][index % 4]).fill(index);
            const encoded = codec.encode({ data });
            return { data, encoded, snapshot: encoded.slice() };
        });
        expect(retained.some(({ encoded }) => encoded.byteOffset > 0)).toBe(true);

        for (const { data, encoded, snapshot } of retained) {
            expect(encoded).toEqual(snapshot);
            expect(codec.decode(encoded)).toEqual({ data });
        }

        retained[0].encoded.fill(0);

        for (const { encoded, snapshot } of retained.slice(1)) {
            expect(encoded).toEqual(snapshot);
        }
    });

    it('supports encoding from a getter without reusing the inner result', () => {
        const codec = schemaCodecs<{ data: Uint8Array }>(bytesSchema);
        const inner = new Uint8Array(128).fill(7);
        const outer = new Uint8Array(256).fill(9);
        let nested: Uint8Array | undefined;
        const encoded = codec.encode({
            get data() {
                nested = codec.encode({ data: inner });
                return outer;
            },
        });
        expect(codec.decode(encoded)).toEqual({ data: outer });
        expect(codec.decode(nested!)).toEqual({ data: inner });
    });

    it('replaces a slab whose backing buffer was transferred', () => {
        const codec = schemaCodecs<{ data: Uint8Array }>(bytesSchema);
        const data = new Uint8Array(128).fill(3);
        const first = codec.encode({ data });
        const transferred = structuredClone(first, { transfer: [first.buffer as ArrayBuffer] });
        expect(first.byteLength).toBe(0);
        expect(codec.decode(transferred)).toEqual({ data });
        expect(codec.decode(codec.encode({ data }))).toEqual({ data });
    });

    it('decodes unaligned pooled messages containing strings, fixed values and nested data', () => {
        const codec = schemaCodecs<{
            text: string;
            ratio: number;
            inner: { value: bigint; data: Uint8Array };
        }>(`
      interface Inner {value:pb<1,fixed_64>;data:pb<2,bytes>;}
      interface Msg {text:pb<1,string>;ratio:pb<2,double>;inner:pb<3,Inner>;}
    `);
        let unaligned = false;

        for (let i = 0; i < 100; i++) {
            const value = {
                text: '中文🚀'.repeat(8) + i,
                ratio: Math.PI + i,
                inner: { value: (1n << 63n) + BigInt(i), data: new Uint8Array(17 + i).fill(i) },
            };
            const encoded = codec.encode(value);
            unaligned ||= encoded.byteOffset % 8 !== 0;
            expect(codec.decode(encoded)).toEqual(value);
        }

        expect(unaligned).toBe(true);
    });
});
