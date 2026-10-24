import { bundle } from '../project';
import { describe, expect, it } from 'vitest';
import { run, imports } from '../compile';
import { ProtobufCompiler } from '../../../src/compiler/compiler';

const box = 'interface Box<T> {value:pb<1,T>;}';
const codec = `${box}
  class Codec<T> {
    encode(value:Box<T>) {return protobuf_encode<Box<T>>(value);}
    decode(bytes:Uint8Array) {return protobuf_decode<Box<T>>(bytes);}
  }`;

describe('generic class instances', () => {
    it('isolates uint32 and string instances across alternating calls', () => {
        const result = run(`${codec}
      const numbers=new Codec<uint_32>(); const strings=new Codec<string>();
      export const result=Array.from({length:32},(_,i)=>[numbers.decode(numbers.encode({value:i})),strings.decode(strings.encode({value:'v'+i}))]);
      export const sharedMethod=numbers.encode===strings.encode;
      export const keys=Object.keys(numbers);
    `);
        expect(result.result).toEqual(
            Array.from({ length: 32 }, (_, i) => [{ value: i }, { value: 'v' + i }]),
        );
        expect(result.sharedMethod).toBe(true);
        expect(result.keys).toEqual([]);
    });

    it('emits one codec per concrete type for many instances', () => {
        const declarations = Array.from(
            { length: 32 },
            (_, i) => `const n${i}=new Codec<uint_32>(); const s${i}=new Codec<string>();`,
        ).join('\n');
        const output = new ProtobufCompiler().compile(imports + codec + declarations, 'reuse.ts')!;
        expect(output.match(/function protobuf_encode_Box__uint_32\(/g)).toHaveLength(1);
        expect(output.match(/function protobuf_decode_Box__uint_32\(/g)).toHaveLength(1);
        expect(output.match(/function protobuf_encode_Box__string\(/g)).toHaveLength(1);
        expect(output.match(/function protobuf_decode_Box__string\(/g)).toHaveLength(1);
    });

    it('alternates method type arguments on one instance', () => {
        expect(
            run(`${box}
      class Codec {roundtrip<T>(value:Box<T>) {return protobuf_decode<Box<T>>(protobuf_encode<Box<T>>(value));}}
      const instance=new Codec();
      export const result=[instance.roundtrip<uint_32>({value:7}),instance.roundtrip<string>({value:'x'}),instance.roundtrip<uint_32>({value:8})];
    `).result,
        ).toEqual([{ value: 7 }, { value: 'x' }, { value: 8 }]);
    });

    it('forwards outer generics through factories returning class instances', () => {
        expect(
            run(`${codec}
      function create<T>() {return new Codec<T>();}
      const n=create<uint_32>(); const s=create<string>();
      export const result=[n.decode(n.encode({value:7})),s.decode(s.encode({value:'x'}))];
    `).result,
        ).toEqual([{ value: 7 }, { value: 'x' }]);
    });

    it('combines factory class arguments and independent method arguments', () => {
        expect(
            run(`interface Pair<T,U> {first:pb<1,T>;second:pb<2,U>;}
      class Codec<T> {roundtrip<U>(value:Pair<T,U>) {return protobuf_decode<Pair<T,U>>(protobuf_encode<Pair<T,U>>(value));}}
      function create<T>():Codec<T> {return new Codec<T>();}
      const n=create<uint_32>(); const s=create<string>(); const alias=n;
      export const result=[n.roundtrip<string>({first:7,second:'x'}),s.roundtrip<uint_32>({first:'y',second:8}),alias.roundtrip<uint_32>({first:9,second:10}),create<string>().roundtrip<string>({first:'a',second:'b'})];
    `).result,
        ).toEqual([
            { first: 7, second: 'x' },
            { first: 'y', second: 8 },
            { first: 9, second: 10 },
            { first: 'a', second: 'b' },
        ]);
    });

    it('infers constructor generics from annotated arguments', () => {
        expect(
            run(`${box}
      class Codec<T> {constructor(readonly value:Box<T>) {} encode(){return protobuf_encode<Box<T>>(this.value);}}
      const n:Box<uint_32>={value:7}; const s:Box<string>={value:'x'};
      const numbers=new Codec(n); const strings=new Codec(s);
      export const result=[[...numbers.encode()],[...strings.encode()]];
    `).result,
        ).toEqual([
            [8, 7],
            [10, 1, 120],
        ]);
    });

    it('infers factories and inherited constructors with renamed parameters', () => {
        expect(
            run(`${box}
      class Codec<T> {constructor(readonly value:Box<T>) {} encode(){return protobuf_encode<Box<T>>(this.value);}}
      class Middle<V> extends Codec<V> {}
      class Derived<U> extends Middle<U> {}
      function create<W>(value:Box<W>) {return new Derived(value);}
      const n:Box<uint_32>={value:7}; const s:Box<string>={value:'x'};
      const numbers=create(n); const strings=create(s);
      export const result=[[...numbers.encode()],[...strings.encode()]];
    `).result,
        ).toEqual([
            [8, 7],
            [10, 1, 120],
        ]);
    });

    it('specializes unannotated factories, aliases and default class arguments', () => {
        expect(
            run(`interface Pair<T,U> {first:pb<1,T>;second:pb<2,U>;}
      class Codec<T=string> {roundtrip<U>(value:Pair<T,U>) {return protobuf_decode<Pair<T,U>>(protobuf_encode<Pair<T,U>>(value));}}
      const create=<T>()=>new Codec<T>();
      type Alias<T> = Codec<T>;
      function use<T>(instance:Alias<T>, first:T) {return instance.roundtrip<string>({first,second:'ok'});}
      export const result=[create<uint_32>().roundtrip<string>({first:7,second:'x'}),new Codec().roundtrip<uint_32>({first:'y',second:8}),use<string>(create<string>(),'z')];
    `).result,
        ).toEqual([
            { first: 7, second: 'x' },
            { first: 'y', second: 8 },
            { first: 'z', second: 'ok' },
        ]);
    });

    it('retains class bindings in generic callback adapters', () => {
        expect(
            run(`interface Pair<T,U> {first:pb<1,T>;second:pb<2,U>;}
      class Codec<T> {roundtrip<U>(value:Pair<T,U>) {return protobuf_decode<Pair<T,U>>(protobuf_encode<Pair<T,U>>(value));}}
      function create<T>():Codec<T> {return new Codec<T>();}
      const numbers=create<uint_32>(); const strings=create<string>();
      const n=numbers.roundtrip<string>.bind(numbers); const s=strings.roundtrip<uint_32>.bind(strings);
      export const result=[n({first:7,second:'x'}),s({first:'y',second:8})];
    `).result,
        ).toEqual([
            { first: 7, second: 'x' },
            { first: 'y', second: 8 },
        ]);
    });

    it('separates specializations through inherited constructors', () => {
        expect(
            run(`${codec}
      class Derived<T> extends Codec<T> {}
      const n=new Derived<uint_32>(); const s=new Derived<string>();
      export const result=[n.decode(n.encode({value:7})),s.decode(s.encode({value:'x'}))];
    `).result,
        ).toEqual([{ value: 7 }, { value: 'x' }]);
    });

    it('keeps cross-file factory instances specialized', async () => {
        expect(
            await bundle({
                'codec.ts': `${imports} ${codec} export function create<T>() {return new Codec<T>();}`,
                'entry.ts': `import {create} from './codec'; const n=create<uint_32>();const s=create<string>(); export const result=[n.decode(n.encode({value:7})),s.decode(s.encode({value:'x'}))];`,
            }),
        ).toEqual({ result: [{ value: 7 }, { value: 'x' }] });
    });

    it('resolves method defaults from the class type argument', () => {
        expect(
            run(`interface Pair<T,U> {first:pb<1,T>;second:pb<2,U>;}
      class Codec<T> {roundtrip<U=T>(value:Pair<T,U>) {return protobuf_decode<Pair<T,U>>(protobuf_encode<Pair<T,U>>(value));}}
      function create<T>():Codec<T> {return new Codec<T>();}
      export const result=[create<uint_32>().roundtrip({first:7,second:8}),create<string>().roundtrip({first:'x',second:'y'})];
    `).result,
        ).toEqual([
            { first: 7, second: 8 },
            { first: 'x', second: 'y' },
        ]);
    });

    it('specializes inherited static generic methods', () => {
        expect(
            run(`${box}
      class Base {static roundtrip<T>(value:Box<T>) {return protobuf_decode<Box<T>>(protobuf_encode<Box<T>>(value));}}
      class Codec extends Base {}
      export const result=[Codec.roundtrip<uint_32>({value:7}),Codec.roundtrip<string>({value:'x'})];
    `).result,
        ).toEqual([{ value: 7 }, { value: 'x' }]);
    });

    it('combines cross-file class and method generics', async () => {
        expect(
            await bundle({
                'codec.ts': `${imports} export interface Pair<T,U> {first:pb<1,T>;second:pb<2,U>;}
        class Codec<T> {roundtrip<U>(value:Pair<T,U>) {return protobuf_decode<Pair<T,U>>(protobuf_encode<Pair<T,U>>(value));}}
        export const create=<T>()=>new Codec<T>();`,
                'entry.ts': `import {create} from './codec'; const n=create<uint_32>(); const s=create<string>();
        export const result=[n.roundtrip<string>({first:7,second:'x'}),s.roundtrip<uint_32>({first:'y',second:8})];`,
            }),
        ).toEqual({
            result: [
                { first: 7, second: 'x' },
                { first: 'y', second: 8 },
            ],
        });
    });
});
