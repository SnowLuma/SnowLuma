import { describe, expect, it } from 'vitest';
import { run, imports } from '../upstream/compile';
import { bundle } from '../upstream/project';
import { schemaCodecs, schemaRegistry } from '../upstream/schema';
import { generateCode } from '../../src/codegen/generator';
import { protobuf_getUnknownFields } from '../../src/runtime';
import { ProtobufCompiler } from '../../src/compiler/compiler';
import { withProject } from '../upstream/project';
import { join } from 'node:path';

describe('SnowLuma compatibility', () => {
    it('leaves generic data unions and nested business types outside codec discovery', () => {
        expect(
            run(`
            type Json = string | Json[];
            interface Field<T> {value:T; metadata:Json;}
            type Wrapper<T> = Field<T> & { extra?:Json };
            function identity<T>(value:Field<T>) {return value;}
            function generic<T>(field:Field<Wrapper<T>>) {return identity(field);}
            function result<T>(ok:boolean, value:T) {if(ok) return {ok:true, value}; return {ok:false, value};}
            const field:Field<Wrapper<string>> = {value:{value:'ok', metadata:[]}, metadata:[]};
            export const output = result(true, generic(field)).value.value.value;
        `).output,
        ).toBe('ok');
    });

    it('keeps unrelated callback aliases and inferred containers lazy', () => {
        expect(
            run(`
            type Json = string | Json[];
            type Handler<T> = (value:T) => void;
            interface Field<T> {value:T; metadata:Json;}
            const field:Field<Json> = {value:'ok', metadata:[]};
            function wrap<T>(value:Field<T>) {return {get(){return value.value;}};}
            const handler:Handler<Json> = (value) => {};
            handler('x');
            export const result = wrap(field).get();
        `).result,
        ).toBe('ok');
    });

    it('propagates composite class bindings through generic factories', () => {
        expect(
            run(`
            interface Box<T> { value:pb<1,T>; }
            class Codec<T> { encode(value:T) { return protobuf_encode<T>(value); } }
            function create<T>() { return new Codec<Box<T>>(); }
            export const result = [...create<uint_32>().encode({value:7})];
        `).result,
        ).toEqual([8, 7]);
    });

    it('defers unrelated class type arguments but validates codec class schemas', () => {
        expect(
            run(`
            type Json = string | Json[];
            class Field<T> { value(): null { return null; } }
            function field() { return new Field<Json>(); }
            export const result = field().value();
        `).result,
        ).toBeNull();
        expect(() =>
            run(`
            class Codec<T> { encode(value:T) {return protobuf_encode<T>(value);} }
            new Codec<Missing>().encode({});
        `),
        ).toThrow(/Unresolved type Missing/);
    });

    it('infers matching generic containers without expanding unrelated recursive data', () => {
        expect(
            run(`
            type Json = string | Json[];
            interface Field<T> { value: T; metadata: Json; }
            function arrayField<E>(field: Field<E>) { return Object.assign({}, { get: () => field.value }); }
            function wrap<E>(field: Field<E>) { return arrayField(field); }
            const field: Field<string> = { value:'ok', metadata:[] };
            export const result = wrap(field).get();
        `).result,
        ).toBe('ok');
    });

    it('does not resolve recursive data aliases while looking for class receivers', () => {
        expect(
            run(`
            type Data<T> = { children: T[]; name: string };
            type Element = Data<Element>;
            type Wrapped<T> = T;
            function data(): Wrapped<Element> { return { children: [], name: 'ok' }; }
            export const result = data().name.toUpperCase();
        `).result,
        ).toBe('OK');
    });

    it('does not resolve ordinary generic return values or data alias members as callbacks', () => {
        expect(
            run(`
            type Id<T> = T;
            interface Data { value: string; children: Id<Data>[]; }
            const data: Id<Data> = {value:'ok', children:[]};
            function decode<T>(raw: Uint8Array, callback: () => T): T | null { return callback(); }
            const raw: Uint8Array = new Uint8Array();
            const decoded = decode(raw, () => data);
            export const result = [decoded.value, data.value];
        `).result,
        ).toEqual(['ok', 'ok']);
    });

    it('does not specialize ambient library functions', async () => {
        const source = `import { expect } from './external';
            const data: Record<string, unknown> = {};
            expect(data).check();`;
        await withProject(
            {
                'external.d.ts': 'export declare function expect<T>(value: T): { check(): void };',
                'entry.ts': source,
            },
            (directory) => {
                expect(
                    new ProtobufCompiler().compile(source, join(directory, 'entry.ts')),
                ).toBeNull();
            },
        );
    });

    it('leaves ordinary calls and data receivers outside schema resolution', () => {
        expect(
            run(`
            interface Options { meta?: Record<string, unknown>; }
            function options(value: Options): Options { return value; }
            const input: Options = { meta: { source: 'test' } };
            const copy = options(input);
            function data(flag: boolean) { if (flag) return { value: 7 }; return { value: 8 }; }
            function bytes(value: Uint8Array): Uint8Array { return value; }
            const raw: Uint8Array = new Uint8Array([1]);
            export const result = [copy.meta.source, data(true).value, bytes(raw).length];
        `).result,
        ).toEqual(['test', 7, 1]);
    });

    it('keeps TypeScript optionality separate from explicit wire presence', () => {
        const result = run(`
            interface Msg {
                plain?: pb<1, uint_32>;
                flag?: pb<2, bool>;
                text?: pb<3, string>;
                data?: pb<4, bytes>;
                big?: pb<5, uint_64>;
                forced?: pb_optional<6, uint_32>;
            }
            export const wire = [...protobuf_encode<Msg>({
                plain: 0, flag: false, text: '', data: new Uint8Array(), big: 0n, forced: 0,
            })];
            export const decoded = protobuf_decode<Msg>(new Uint8Array(wire));
        `);
        expect(result.wire).toEqual([48, 0]);
        expect(result.decoded).toEqual({
            plain: null,
            flag: null,
            text: null,
            data: null,
            big: null,
            forced: 0,
        });
    });

    it('retains aliased markers and presence through exported generic wrappers', async () => {
        const result = await bundle({
            'schema.ts': `import type { pb as P, pb_optional as O, pb_repeated as R, uint_32 } from '@snowluma/proton';
                export interface Box<T> { value?: P<1, T>; }
                export interface Msg { plain?: P<1, uint_32>; forced?: O<2, uint_32>; items?: R<3, uint_32>; }
                export interface Outer<U> { inner?: P<1, Box<U>>; }`,
            'barrel.ts': `export * from './schema';`,
            'wrapper.ts': `${imports} import type {Outer} from './barrel';
                export function encode<T>(value:Outer<T>) { return protobuf_encode<Outer<T>>(value); }`,
            'forward.ts': `import {encode} from './wrapper'; import type {Outer} from './barrel';
                export function forward<T>(value:Outer<T>) { return encode<T>(value); }`,
            'entry.ts': `${imports} import type {Msg} from './barrel'; import {forward} from './forward';
                export const wire = [...forward<Msg>({inner:{value:{plain:0,forced:0,items:[0,7]}}})];`,
        });
        expect(result.wire).toEqual([10, 8, 10, 6, 16, 0, 24, 0, 24, 7]);
    });

    it.each([true, false])('resolves package exports with tsconfig=%s', async (withConfig) => {
        const result = await bundle({
            ...(withConfig
                ? {
                      'tsconfig.json': JSON.stringify({
                          compilerOptions: { moduleResolution: 'bundler', module: 'esnext' },
                      }),
                  }
                : {}),
            'node_modules/@fake/schemas/package.json': JSON.stringify({
                name: '@fake/schemas',
                type: 'module',
                exports: { '.': { types: './index.ts', default: './index.ts' } },
            }),
            'node_modules/@fake/schemas/index.ts': `export * from './schema';`,
            'node_modules/@fake/schemas/schema.ts': `export interface Msg { value:pb<1,uint_32>; }`,
            'entry.ts': `${imports} import type {Msg} from '@fake/schemas';
                export const result = protobuf_decode<Msg>(protobuf_encode<Msg>({value:42}));`,
        });
        expect(result).toEqual({ result: { value: 42 } });
    });

    const codec = schemaCodecs<{ value: number }>('interface Msg { value:pb<1,uint_32>; }');
    it.each([
        ['unterminated group', [0x13, 8, 7]],
        ['mismatched group', [0x13, 0x1c]],
        ['unexpected group end', [0x14]],
        ['invalid group tag', [0x13, 0]],
        ['group payload exceeds frame', [0x13, 0x1a, 4, 0x14]],
        ['group recursion limit', [...Array(66).fill(0x13), ...Array(66).fill(0x14)]],
    ] as const)('rejects %s', (_name, bytes) => {
        expect(() => codec.decode(Uint8Array.from(bytes))).toThrow(/protobuf/);
    });

    it('skips nested groups and retains non-enumerable metadata', () => {
        const decoded = codec.decode(Uint8Array.from([0x13, 0x1b, 8, 99, 0x1c, 0x14, 8, 7]));
        expect(decoded).toEqual({ value: 7 });
        expect(protobuf_getUnknownFields(decoded)).toEqual([
            { fieldNumber: 2, wireType: 3, count: 1, totalByteLength: 5 },
        ]);
        expect(JSON.stringify(decoded)).toBe('{"value":7}');
        expect([...codec.encode(decoded)]).toEqual([8, 7]);
    });

    it.each([
        [NaN, 0],
        [0, NaN],
        [0.5, 1],
        [0, 0.5],
        [-1, 1],
        [1, 0],
        [0, 3],
        [0, Infinity],
    ])('rejects invalid decoder bounds %s..%s', (offset, end) => {
        const generated = generateCode(schemaRegistry('interface Msg { value:pb<1,uint_32>; }'));
        const decode = new Function(generated + '\nreturn protobuf_decode_Msg;')();
        expect(() => decode(new Uint8Array([8, 1]), offset, end)).toThrow(/bounds/);
    });
});
