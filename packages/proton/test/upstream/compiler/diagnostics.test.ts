import { describe, expect, it } from 'vitest';
import { ProtobufCompiler } from '../../../src/compiler/compiler';
import { imports, run } from '../compile';
import { withProject } from '../project';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

describe('compiler failure recovery', () => {
    it('rejects circular class inheritance without looping during member resolution', () => {
        expect(() =>
            run(
                `class A<T> extends B<T> {} class B<U> extends A<U> {} new A<uint_32>().missing();`,
            ),
        ).toThrow(/Circular class inheritance/);
    });

    it('rejects circular schema inheritance without caching an empty message', () => {
        expect(() =>
            run(`interface A extends B {} interface B extends A {} protobuf_encode<A>({});`),
        ).toThrow(/Circular schema inheritance/);
    });
    it('does not cache a partially validated schema after failure', () => {
        const compiler = new ProtobufCompiler();
        const source = `${imports} interface Msg {a:pb<1,uint_32>;b:pb<1,string>;} protobuf_encode<Msg>({a:7,b:'x'});`;

        for (let i = 0; i < 3; i++) {
            expect(() => compiler.compile(source, 'invalid.ts')).toThrow(
                /Duplicate protobuf field number/,
            );
        }

        expect(compiler.compile(source.replace('b:pb<1,', 'b:pb<2,'), 'invalid.ts')).toContain(
            'protobuf_encode_Msg',
        );
    });

    it('reports expanding recursive schema aliases before overflowing the stack', () => {
        expect(() =>
            run(
                `type Grow<T>={value:pb<1,T>;next?:pb<2,Grow<Grow<T>>>;}; protobuf_encode<Grow<uint_32>>({value:7});`,
            ),
        ).toThrow(/128 levels|does not converge/);
    });

    it('reports circular aliases with a source location', () => {
        expect(() => run(`type A=B; type B=A; protobuf_encode<A>({});`)).toThrow(
            /test-entry.ts:\d+:\d+: Circular type alias/,
        );
    });

    it('replaces specialized code when the same module repeatedly changes wire types', () => {
        const compiler = new ProtobufCompiler();

        for (let i = 0; i < 32; i++) {
            const type = i % 2 ? 'string' : 'uint_32';
            const other = i % 2 ? 'uint_32' : 'string';
            const source = `${imports} interface Box<T> {value:pb<1,T>;} class Codec<T> {encode(value:Box<T>) {return protobuf_encode<Box<T>>(value);}} new Codec<${type}>();`;
            const output = compiler.compile(source, 'changing.ts');
            expect(output).toContain(`function protobuf_encode_Box__${type}(`);
            expect(output).not.toContain(`function protobuf_encode_Box__${other}(`);
        }
    });

    it('rejects ambiguous factory specializations with a build diagnostic', () => {
        expect(() =>
            run(`interface Box<T> {value:pb<1,T>;}
      class Codec<T> {encode<U>(value:Box<T>) {return protobuf_encode<Box<T>>(value);}}
      function create(flag:boolean) {if(flag) return new Codec<uint_32>();return new Codec<string>();}
      create(true).encode<bool>({value:7});
    `),
        ).toThrow(/Receiver branches must resolve to the same specialization/);
    });

    it('reconstructs all entry requirements after a failed compilation', async () => {
        const shared =
            'export function apply<T>(value:T, fn:<U>(value:U)=>Uint8Array) {return fn<T>(value);}';
        await withProject(
            {
                'shared.ts': shared,
                'a.ts': `${imports} import {apply} from './shared'; interface Msg {value:pb<1,uint_32>;} function encode<T>(value:T) {return protobuf_encode<T>(value);} apply<Msg>({value:7},encode);`,
                'b.ts': `${imports} import {apply} from './shared'; interface Msg {value:pb<1,uint_32>;} interface Box<T> {value:pb<1,T>;} function encode<T>(value:T) {return protobuf_encode<Box<T>>({value});} apply<Msg>({value:8},encode);`,
            },
            (directory) => {
                const compiler = new ProtobufCompiler();
                compiler.prepare([join(directory, 'a.ts'), join(directory, 'b.ts')]);
                const baseline = compiler.compile(shared, join(directory, 'shared.ts'));
                expect(() =>
                    compiler.compile(
                        `${imports} protobuf_encode<Missing>({});`,
                        join(directory, 'bad.ts'),
                    ),
                ).toThrow(/Unresolved type/);
                expect(compiler.compile(shared, join(directory, 'shared.ts'))).toBe(baseline);
            },
        );
    });

    it('recovers when entry preparation fails before a corrected source is saved', async () => {
        const source = `${imports} interface Msg {value:pb<1,uint_32>;} function encode<T>(value:T) {return protobuf_encode<T>(value);} encode({value:7});`;
        await withProject({ 'entry.ts': source }, (directory) => {
            const compiler = new ProtobufCompiler();
            const file = join(directory, 'entry.ts');

            for (let i = 0; i < 2; i++) {
                expect(() => compiler.prepare([file])).toThrow(/Cannot infer T/);
            }

            const corrected = source.replace('encode({', 'encode<Msg>({');
            writeFileSync(file, corrected);
            compiler.prepare([file]);
            expect(compiler.compile(corrected, file)).toContain('protobuf_encode_Msg');
        });
    });
});
