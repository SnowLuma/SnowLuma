import { bundle } from '../project';
import { packageName } from '../../../src/package';
import { describe, expect, it } from 'vitest';
import { ProtobufCompiler } from '../../../src/compiler/compiler';

import { run, imports } from '../compile';

describe('semantic compiler', () => {
    it('invalidates preloaded schema types when the transform receives different source', () => {
        const compiler = new ProtobufCompiler();
        const source = `${imports} interface Msg {value:pb<1,uint_32>;} protobuf_encode<Msg>({value:7});`;
        compiler.context.source('preloaded.ts', source);
        compiler.prepare(['preloaded.ts']);
        expect(compiler.compile(source.replace('pb<1,', 'pb<2,'), 'preloaded.ts')).toContain(
            'buf[offset++] = 16;',
        );
    });
    it('preserves async generic function bodies and return values', async () => {
        const result = run(`interface Msg { value: pb<1,uint_32>; }
      async function encode<T>(value:T) { await Promise.resolve(); return protobuf_encode<T>(value); }
      export const result = encode<Msg>({value:7});
    `);
        expect([...(await result.result)]).toEqual([8, 7]);
    });
    it('supports namespace markers and namespace runtime functions', () => {
        expect(
            run(`
      import * as p from '${packageName}';
      interface Msg { value: p.pb<1, p.uint_32>; }
      export const result = [...p.protobuf_encode<Msg>({value: 7})];
    `).result,
        ).toEqual([8, 7]);
    });

    it('supports default generic classes and re-exported runtime bindings', async () => {
        expect(
            await bundle({
                'runtime.ts': `export { protobuf_encode as encode } from '${packageName}';`,
                'codec.ts': `import { encode } from './runtime'; export default class Codec<T> { encode(value:T) { return encode<T>(value); } }`,
                'entry.ts': `import Codec from './codec'; interface Msg { value: pb<1,uint_32>; } const codec = new Codec<Msg>(); export const result = [...codec.encode({value:7})];`,
            }),
        ).toEqual({ result: [8, 7] });
    });

    it('resolves generic parameters containing dollar signs without text substitution', () => {
        expect(
            run(`interface Box<$T> { value: pb<1,$T>; }
      function encode<$T>(value:Box<$T>) { return protobuf_encode<Box<$T>>(value); }
      export const result = [...encode<string>({value:'x'})];
    `).result,
        ).toEqual([10, 1, 120]);
    });

    it('preserves directive prologues', () => {
        const code = `'use client';\n${imports}\ninterface Msg { value: pb<1,uint_32>; } protobuf_encode<Msg>({value:7});`;
        expect(new ProtobufCompiler().compile(code, 'directive.ts')).toMatch(/^'use client';/);
    });

    it('does not mix anonymous fields instantiated with different generic arguments', () => {
        expect(
            run(`
      interface Box<T> { nested: pb<1, { value: pb<1, T>; }>; }
      export const a = protobuf_decode<Box<uint_32>>(protobuf_encode<Box<uint_32>>({ nested: { value: 7 } }));
      export const b = protobuf_decode<Box<string>>(protobuf_encode<Box<string>>({ nested: { value: 'x' } }));
    `),
        ).toEqual({ a: { nested: { value: 7 } }, b: { nested: { value: 'x' } } });
    });

    it('evaluates conditional schema types structurally', () => {
        expect(
            run(`
      interface Base { id: pb<1, uint_32>; }
      interface Child extends Base { text: pb<2, string>; }
      type Chosen<T> = T extends Base ? Child : never;
      export const result = protobuf_decode<Chosen<Child>>(protobuf_encode<Chosen<Child>>({ id: 7, text: 'x' }));
    `).result,
        ).toEqual({ id: 7, text: 'x' });
    });

    it('supports destructured generic object methods and aliases', () => {
        expect(
            run(`
      interface Msg { value: pb<1, uint_32>; }
      const api = { encode<T>(value: T) { return protobuf_encode<T>(value); } };
      const { encode: send } = api;
      export const result = [...send<Msg>({ value: 7 })];
    `).result,
        ).toEqual([8, 7]);
    });

    it('rejects generic callbacks without a concrete adapter', () => {
        expect(() =>
            run(`
      interface Msg { value: pb<1, uint_32>; }
      function encode<T>(value: T) { return protobuf_encode<T>(value); }
      [{ value: 7 }].map(encode);
    `),
        ).toThrow(/Cannot infer callback schema/);
    });

    it('rejects detached instance codec methods', () => {
        expect(() =>
            run(`interface Msg { value: pb<1,uint_32>; }
      class Codec<T> { encode(value:T) { return protobuf_encode<T>(value); } }
      const codec = new Codec<Msg>(); const encode = codec.encode;
    `),
        ).toThrow(/receiver/);
    });

    it('rejects class field calls that run before codec initialization', () => {
        expect(() => run(`class Codec<T> { value = protobuf_encode<T>({} as T); }`)).toThrow(
            /field initializers/,
        );
    });

    it('keeps function length stable after generic codec injection', () => {
        expect(
            run(`
      interface Msg { value: pb<1, uint_32>; }
      function encode<T>(value: T) { return protobuf_encode<T>(value); }
      export const length = encode.length;
      export const result = [...encode<Msg>({ value: 7 })];
    `),
        ).toEqual({ length: 1, result: [8, 7] });
    });

    it('reuses exact transform results and clears changed-source caches', () => {
        const compiler = new ProtobufCompiler();
        const source = `${imports} interface Msg { value: pb<1, uint_32>; } protobuf_encode<Msg>({value: 7});`;
        const first = compiler.compile(source, 'cache.ts');
        expect(compiler.compile(source, 'cache.ts')).toBe(first);
        const second = compiler.compile(source.replace('pb<1,', 'pb<2,'), 'cache.ts');
        expect(second).toContain('buf[offset++] = 16;');
        expect(second).not.toEqual(first);
    });

    it('resolves tsconfig path aliases', async () => {
        expect(
            await bundle({
                'tsconfig.json': JSON.stringify({
                    compilerOptions: { baseUrl: '.', paths: { '@schema/*': ['schema/*'] } },
                }),
                'schema/msg.ts': 'export interface Msg { value: pb<1, uint_32>; }',
                'entry.ts': `${imports} import type { Msg } from '@schema/msg'; export const result = [...protobuf_encode<Msg>({value:7})];`,
            }),
        ).toEqual({ result: [8, 7] });
    });

    it('supports recursive generic aliases and nested generic inference', () => {
        expect(
            run(`
      type Node<T> = { value: pb<1, T>; next?: pb<2, Node<T>>; };
      function encode<T>(value: Node<T>) { return protobuf_encode<Node<T>>(value); }
      const value: Node<string> = { value: 'a', next: { value: 'b' } };
      export const result = protobuf_decode<Node<string>>(encode(value));
    `).result,
        ).toEqual({ value: 'a', next: { value: 'b', next: null } });
    });

    it('supports inferred generic forwarding and inherited generic methods', () => {
        expect(
            run(`
      interface Pair<T, U> { a: pb<1, T>; b: pb<2, U>; }
      class Base<T> { encode<U>(v: Pair<T, U>) { return protobuf_encode<Pair<T, U>>(v); } }
      class Derived<T> extends Base<T> {}
      const codec = new Derived<uint_32>();
      export const result = [...codec.encode<string>({ a: 7, b: 'x' })];
    `).result,
        ).toEqual([8, 7, 18, 1, 120]);
    });

    it('keeps generated helper names and user property strings separate', () => {
        expect(
            run(`
      const __td = 'user decoder';
      const protobuf_encode_Msg = 'user encoder';
      interface Msg { '__td': pb<1, string>; }
      export const result = protobuf_decode<Msg>(protobuf_encode<Msg>({ __td: 'ok' }));
      export const untouched = [__td, protobuf_encode_Msg];
    `),
        ).toEqual({ result: { __td: 'ok' }, untouched: ['user decoder', 'user encoder'] });
    });

    it('shares codecs across distinct instantiations without mixing schemas', () => {
        expect(
            run(`
      interface A { value: pb<1, uint_32>; }
      interface B { value: pb<2, string>; }
      const encode = <T>(value: T) => protobuf_encode<T>(value);
      export const result = [[...encode<A>({ value: 7 })], [...encode<B>({ value: 'x' })]];
    `).result,
        ).toEqual([
            [8, 7],
            [18, 1, 120],
        ]);
    });

    it('supports generic field-number aliases and preserves mapped optionality', () => {
        expect(
            run(`
      type Field<N extends number, T> = pb_optional<N, T>;
      interface Msg { value?: Field<3, uint_32>; }
      type Copy<T> = { [K in keyof T]: T[K] };
      export const result = [...protobuf_encode<Copy<Msg>>({ value: 0 })];
    `).result,
        ).toEqual([24, 0]);
    });

    it('forwards codecs through implicit and explicit generic derived constructors', () => {
        expect(
            run(`
      interface Msg { value: pb<1, uint_32>; }
      class Base<T> {
        constructor(public label = 'base') {}
        encode(value: T) { return protobuf_encode<T>(value); }
      }
      class Middle<T> extends Base<T> {}
      class Derived<T> extends Middle<T> {
        constructor(label: string) { super(label); }
      }
      const codec = new Derived<Msg>('ok');
      export const result = [...codec.encode({ value: 7 })];
      export const label = codec.label;
    `),
        ).toEqual({ result: [8, 7], label: 'ok' });
    });

    it('forwards concrete codecs through a non-generic derived class', () => {
        expect(
            run(`
      interface Msg { value: pb<1, uint_32>; }
      class Base<T> { encode(value: T) { return protobuf_encode<T>(value); } }
      class Codec extends Base<Msg> {}
      export const result = [...new Codec().encode({ value: 7 })];
    `).result,
        ).toEqual([8, 7]);
    });

    it('preserves explicitly present optional default values and quoted field names', () => {
        const result = run(`
      interface Msg { 'a-b'?: pb_optional<1, uint_32>; flag?: pb_optional<2, bool>; text?: pb_optional<3, string>; big?: pb_optional<4, uint_64>; '__proto__'?: pb<5, string>; }
      const input = { 'a-b': 0, flag: false, text: '', big: 0n, ['__proto__']: 'safe' };
      export const result = protobuf_decode<Msg>(protobuf_encode<Msg>(input));
    `).result;
        expect(result).toEqual({ 'a-b': 0, flag: false, text: '', big: 0n, ['__proto__']: 'safe' });
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    });
    it('preserves imported generic wrappers and transitive aliases across .js imports and barrels', async () => {
        const result = await bundle({
            'types.ts': `export interface Box<T> { value: pb<1, T>; }`,
            'codec.ts': `${imports} import type { Box as B } from './types.js';
        let count = 0;
        export function wrap<T>(value: B<T>) { count++; return protobuf_encode<B<T>>(value); }
        export function calls() { return count; }`,
            'barrel.ts': `export { wrap as encode, calls } from './codec.js'; export type { Box as Shape } from './types.js';`,
            'entry.ts': `${imports} import { encode, calls } from './barrel.js'; import type { Shape } from './barrel.js';
        export const result = protobuf_decode<Shape<string>>(encode<string>({ value: 'ok' }));
        export const count = calls();`,
        });
        expect(result).toEqual({ result: { value: 'ok' }, count: 1 });
    });

    it('keeps same-named schemas from different files distinct', async () => {
        const result = await bundle({
            'a.ts': `export interface Msg { value: pb<1, uint_32>; }`,
            'b.ts': `export interface Msg { value: pb<2, string>; }`,
            'entry.ts': `${imports} import type { Msg as A } from './a'; import type * as b from './b';
        export const a = [...protobuf_encode<A>({ value: 7 })];
        export const b = [...protobuf_encode<b.Msg>({ value: 'x' })];`,
        });
        expect(result).toEqual({ a: [8, 7], b: [18, 1, 120] });
    });

    it('supports generic arrow functions and rest parameters without reordering user arguments', () => {
        expect(
            run(`
      interface Msg { value: pb<1, uint_32>; }
      const encode = <T>(value: T, ...suffix: number[]) => [...protobuf_encode<T>(value), ...suffix];
      export const result = encode<Msg>({ value: 7 }, 9, 10);
    `).result,
        ).toEqual([8, 7, 9, 10]);
    });

    it('does not rewrite shadowed protobuf identifiers or unrelated object methods', () => {
        expect(
            run(`
      interface Msg { value: pb<1, uint_32>; }
      function custom(protobuf_encode: <T>(v: T) => number) { return protobuf_encode<Msg>({ value: 7 }); }
      const unrelated = { encode<T>(value: T) { return value; } };
      export const result = custom(() => 99) + unrelated.encode<number>(1);
    `).result,
        ).toBe(100);
    });

    it('preserves generic wrapper branches, argument positions, closures and side effects', () => {
        const result = run(`
      interface Msg { value: pb<1, uint_32>; }
      let count = 0;
      function wrap<I, T>(ignored: I, data: T, enabled = true) {
        count++;
        if (!enabled) return new Uint8Array([99]);
        return protobuf_encode<T>(data);
      }
      export const a = [...wrap<string, Msg>('unused', { value: 7 })];
      export const b = [...wrap<string, Msg>('unused', { value: 8 }, false)];
      export const calls = count;
    `);
        expect(result).toEqual({ a: [8, 7], b: [99], calls: 2 });
    });

    it('propagates concrete codecs through multiple generic functions and nested closures', () => {
        const result = run(`
      interface Box<T> { value: pb<1, T>; }
      function inner<T>(value: Box<T>) { return protobuf_encode<Box<T>>(value); }
      function outer<T>(value: Box<T>) {
        function forward() { return inner<T>(value); }
        return forward();
      }
      export const result = protobuf_decode<Box<string>>(outer<string>({ value: 'ok' }));
    `);
        expect(result.result).toEqual({ value: 'ok' });
    });

    it('resolves aliases, generic defaults, inheritance, intersections and indexed access', () => {
        const result = run(`
      type Scalar = uint_32;
      interface Base<T = Scalar> { id: pb<1, T>; }
      interface Extra { title: pb<2, string>; }
      interface Child extends Base { title: Extra['title']; }
      type Alias<T> = T;
      type Shape = Alias<Pick<Child & Extra, 'id' | 'title'>>;
      export const result = protobuf_decode<Shape>(protobuf_encode<Shape>({ id: 7, title: 'x' }));
    `);
        expect(result.result).toEqual({ id: 7, title: 'x' });
    });

    it('supports mapped and conditional generic types', () => {
        const result = run(`
      interface Msg { id: pb<1, uint_32>; text: pb<2, string>; }
      type Copy<T> = { [K in keyof T]: T[K] };
      type Choice<T> = T extends string ? Copy<Msg> : never;
      export const result = protobuf_decode<Choice<string>>(protobuf_encode<Choice<string>>({ id: 5, text: 'ok' }));
    `);
        expect(result.result).toEqual({ id: 5, text: 'ok' });
    });

    it('passes class type parameters through constructor and instance methods', () => {
        const result = run(`
      interface Msg { value: pb<1, uint_32>; }
      class Codec<T> {
        constructor(public label = 'default') {}
        encode(data: T) { return protobuf_encode<T>(data); }
        decode(bytes: Uint8Array) { return protobuf_decode<T>(bytes); }
      }
      const a = new Codec<Msg>();
      const b = new Codec<Msg>('named');
      export const result = a.decode(b.encode({ value: 9 }));
      export const labels = [a.label, b.label];
      export const keys = Object.keys(a);
    `);
        expect(result).toEqual({
            result: { value: 9 },
            labels: ['default', 'named'],
            keys: ['label'],
        });
    });

    it('supports generic class methods with class and method type arguments', () => {
        const result = run(`
      interface Pair<T, U> { first: pb<1, T>; second: pb<2, U>; }
      class Codec<T> {
        encode<U>(value: Pair<T, U>) { return protobuf_encode<Pair<T, U>>(value); }
      }
      const codec = new Codec<uint_32>();
      export const result = protobuf_decode<Pair<uint_32, string>>(codec.encode<string>({ first: 7, second: 'x' }));
    `);
        expect(result.result).toEqual({ first: 7, second: 'x' });
    });

    it('supports recursive message schemas and nullable links', () => {
        const result = run(`
      interface Node { value: pb<1, uint_32>; next?: pb<2, Node | undefined>; }
      export const result = protobuf_decode<Node>(protobuf_encode<Node>({ value: 1, next: { value: 2 } }));
    `);
        expect(result.result).toEqual({ value: 1, next: { value: 2, next: null } });
    });

    it('infers a generic argument from an annotated variable', () => {
        const result = run(`
      interface Msg { value: pb<1, uint_32>; }
      const data: Msg = { value: 7 };
      function wrap<T>(value: T) { return protobuf_encode<T>(value); }
      export const result = [...wrap(data)];
    `);
        expect(result.result).toEqual([8, 7]);
    });

    it('does not inspect unused unsupported schema declarations', () => {
        expect(
            run(`
      interface Unused { value: pb<1, MissingType>; }
      interface Msg { value: pb<1, uint_32>; }
      export const result = [...protobuf_encode<Msg>({ value: 7 })];
    `).result,
        ).toEqual([8, 7]);
    });

    it.each(['0', '-1', '1.5', '19000', '536870912'])(
        'rejects invalid field number %s at compile time',
        (number) => {
            expect(() =>
                run(
                    `interface Msg { value: pb<${number}, uint_32>; } protobuf_encode<Msg>({ value: 7 });`,
                ),
            ).toThrow(packageName);
        },
    );

    it('rejects duplicate field numbers', () => {
        expect(() =>
            run('interface Msg { a: pb<1, uint_32>; b: pb<1, string>; } protobuf_encode<Msg>({});'),
        ).toThrow(/Duplicate/);
    });
});
