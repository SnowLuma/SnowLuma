import { describe, expect, it } from 'vitest';
import { run, imports } from '../compile';
import { bundle } from '../project';
import { packageName } from '../../../src/package';

const schema =
    'interface Box<T> {value:pb<1,T>;} interface Pair<T,U> {first:pb<1,T>;second:pb<2,U>;}';
const codec = `${schema} class Codec<T> {
  roundtrip<U>(value:Pair<T,U>) {return protobuf_decode<Pair<T,U>>(protobuf_encode<Pair<T,U>>(value));}
}`;

describe('generic composition', () => {
    it('propagates two specializations across a 64-function call chain', () => {
        const functions = Array.from(
            { length: 64 },
            (_, i) =>
                `function f${i}<T>(value:Box<T>) {return ${i === 63 ? 'protobuf_encode<Box<T>>(value)' : `f${i + 1}<T>(value)`};}`,
        ).join('\n');
        expect(
            run(
                `${schema} ${functions} export const result=[[...f0<uint_32>({value:7})],[...f0<string>({value:'x'})]];`,
            ).result,
        ).toEqual([
            [8, 7],
            [10, 1, 120],
        ]);
    });

    it('composes deferred mapped types, promises, classes and polymorphic callbacks', () => {
        expect(
            run(`
      interface Msg {id:pb<1,uint_32>;text:pb<2,string>;ignore:pb<3,bool>;}
      type Payload<T> = Pick<Awaited<T>,'id'|'text'>;
      interface Envelope<T> {value:pb<1,Payload<T>>;}
      function encode<T>(value:Envelope<T>) {return protobuf_encode<Envelope<T>>(value);}
      function apply<T>(value:Envelope<T>,fn:<U>(value:Envelope<U>)=>Uint8Array) {return fn<T>(value);}
      class Codec<T> {encode(value:Envelope<T>){return apply<T>(value,encode);}}
      const codec=new Codec<Promise<Msg>>();
      export const result=protobuf_decode<Envelope<Msg>>(codec.encode({value:{id:7,text:'x'}}));
    `).result,
        ).toEqual({ value: { id: 7, text: 'x' } });
    });
    it('retains outer type arguments across nested local factories', () => {
        expect(
            run(`${codec}
      function outer<T>() {function inner() {return new Codec<T>();} return inner();}
      const n=outer<uint_32>(); const s=outer<string>();
      export const result=[n.roundtrip<string>({first:7,second:'x'}),s.roundtrip<uint_32>({first:'y',second:8})];
    `).result,
        ).toEqual([
            { first: 7, second: 'x' },
            { first: 'y', second: 8 },
        ]);
    });

    it('resolves instances through parameter properties and getters', () => {
        expect(
            run(`${codec}
      class Holder<T> {
        constructor(readonly codec:Codec<T>) {}
        get current():Codec<T> {return this.codec;}
      }
      const holder=new Holder<string>(new Codec<string>());
      export const result=holder.current.roundtrip<uint_32>({first:'x',second:7});
    `).result,
        ).toEqual({ first: 'x', second: 7 });
    });

    it('resolves static element access without changing this', () => {
        expect(
            run(`${codec}
      const c=new Codec<uint_32>();
      export const result=c['roundtrip']<string>({first:7,second:'x'});
    `).result,
        ).toEqual({ first: 7, second: 'x' });
    });

    it('supports overloaded generic methods and constructors', () => {
        expect(
            run(`${schema}
      class Codec<T> {
        value:Box<T>;
        constructor(value:Box<T>);
        constructor(value:Box<T>, label:string);
        constructor(value:Box<T>, public label='default') {this.value=value;}
        encode() {return protobuf_encode<Box<T>>(this.value);}
        roundtrip<U>(value:Box<U>):Box<U>;
        roundtrip<U>(value:Box<U>):Box<U> {return protobuf_decode<Box<U>>(protobuf_encode<Box<U>>(value));}
      }
      const n:Box<uint_32>={value:7}; const c=new Codec(n);
      export const result=[[...c.encode()],c.roundtrip<string>({value:'x'}),c.label];
    `).result,
        ).toEqual([[8, 7], { value: 'x' }, 'default']);
    });

    it('forwards shadowed generic names through deeply nested callbacks', () => {
        expect(
            run(`${schema}
      function roundtrip<T>(value:Box<T>) {return protobuf_decode<Box<T>>(protobuf_encode<Box<T>>(value));}
      function outer<T>(first:Box<T>, fn:<T>(value:Box<T>)=>Box<T>) {
        function middle<U>(next:Box<U>) {
          function inner<T>(value:Box<T>) {return fn<T>(value);}
          return [inner<T>(first),inner<U>(next)];
        }
        return middle<string>({value:'x'});
      }
      export const result=outer<uint_32>({value:7},roundtrip);
    `).result,
        ).toEqual([{ value: 7 }, { value: 'x' }]);
    });

    it('converges through mutually recursive generic functions', () => {
        expect(
            run(`${schema}
      function a<T>(value:Box<T>, depth:number):Box<T> {return depth ? b<T>(value,depth-1) : protobuf_decode<Box<T>>(protobuf_encode<Box<T>>(value));}
      function b<U>(value:Box<U>, depth:number):Box<U> {return a<U>(value,depth);}
      export const result=[a<uint_32>({value:7},32),a<string>({value:'x'},33)];
    `).result,
        ).toEqual([{ value: 7 }, { value: 'x' }]);
    });

    it('keeps class factory specializations through cyclic re-export modules', async () => {
        expect(
            await bundle({
                'codec.ts': `${imports} ${codec} export const create=<T>()=>new Codec<T>();`,
                'first.ts': `export * from './second'; export {create} from './codec';`,
                'second.ts': `export * from './first';`,
                'entry.ts': `import {create} from './second'; export const result=create<string>().roundtrip<uint_32>({first:'x',second:7});`,
            }),
        ).toEqual({ result: { first: 'x', second: 7 } });
    });

    it('recognizes parenthesized runtime aliases and namespace element access', () => {
        expect(
            run(`${schema} import * as runtime from '${packageName}';
      const encode=protobuf_encode; const alias=encode;
      export const result=[
        [...(alias)<Box<uint_32>>({value:7})],
        runtime['protobuf_decode']<Box<string>>(runtime['protobuf_encode']<Box<string>>({value:'x'}))
      ];
    `).result,
        ).toEqual([[8, 7], { value: 'x' }]);
    });

    it('adapts typed callbacks selected by static element access', () => {
        expect(
            run(`${codec}
      const c=new Codec<uint_32>();
      const callback:(value:Pair<uint_32,string>)=>Pair<uint_32,string> = c['roundtrip'].bind(c);
      export const result=callback({first:7,second:'x'});
    `).result,
        ).toEqual({ first: 7, second: 'x' });
    });

    it('captures outer generics in a local class returned from a factory', () => {
        expect(
            run(`${schema}
      function create<T>() {
        class Local {roundtrip<U>(value:Pair<T,U>) {return protobuf_decode<Pair<T,U>>(protobuf_encode<Pair<T,U>>(value));}}
        return new Local();
      }
      export const result=[create<uint_32>().roundtrip<string>({first:7,second:'x'}),create<string>().roundtrip<uint_32>({first:'y',second:8})];
    `).result,
        ).toEqual([
            { first: 7, second: 'x' },
            { first: 'y', second: 8 },
        ]);
    });

    it('resolves namespaced base schemas and separates imported type and value names', async () => {
        expect(
            await bundle({
                'types.ts': `export interface Base<T> {value:pb<1,T>;} export const Base=123;`,
                'entry.ts': `${imports} import type * as types from './types';
        interface Msg<T> extends types.Base<T> {text:pb<2,string>;}
        export const result=protobuf_decode<Msg<uint_32>>(protobuf_encode<Msg<uint_32>>({value:7,text:'x'}));`,
            }),
        ).toEqual({ result: { value: 7, text: 'x' } });
    });

    it('keeps valid recursive references through inherited generic fields', () => {
        expect(
            run(`
      interface Base<T> {next:pb<1,Link<T>|null>;}
      interface Link<T> extends Base<T> {value:pb<2,T>;}
      const value:Link<string>={value:'a',next:{value:'b',next:null}};
      export const result=protobuf_decode<Link<string>>(protobuf_encode<Link<string>>(value));
    `).result,
        ).toEqual({ value: 'a', next: { value: 'b', next: null } });
    });

    it('resolves imported type and value names independently of declaration order', async () => {
        expect(
            await bundle({
                'types.ts': `export const Msg=42; export interface Msg {value:pb<1,uint_32>;}`,
                'barrel.ts': `export {Msg} from './types';`,
                'entry.ts': `${imports} import {Msg} from './barrel'; export const result=[Msg,[...protobuf_encode<Msg>({value:7})]];`,
            }),
        ).toEqual({ result: [42, [8, 7]] });
    });
});
