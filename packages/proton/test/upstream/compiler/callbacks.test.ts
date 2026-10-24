import { bundle } from '../project';
import { describe, expect, it } from 'vitest';
import { run, imports } from '../compile';

const schema = `interface Msg { value: pb<1,uint_32>; }
function encode<T>(value:T) { return protobuf_encode<T>(value); }`;

describe('generic callbacks', () => {
    it.each([
        'const callbacks=[encode];',
        'const api={send:encode};',
        '[{value:7}].map(<T>(value:T)=>protobuf_encode<T>(value));',
        '[{value:7}].map((encode));',
    ])('rejects callback values without enough schema context: %s', (expression) => {
        expect(() => run(schema + expression)).toThrow(/Cannot infer callback schema/);
    });
    it('supports callbacks in default parameters and codec calls in parameter initializers', () => {
        expect(
            run(`${schema}
      function apply<T>(value:T, callback:(value:T)=>Uint8Array=protobuf_encode) {return callback(value);}
      function defaults<T>(value:T, bytes=protobuf_encode<T>(value)) {return bytes;}
      export const result=[[...apply<Msg>({value:7})],[...defaults<Msg>({value:8})]];
      export const lengths=[apply.length, defaults.length];
    `),
        ).toEqual({
            result: [
                [8, 7],
                [8, 8],
            ],
            lengths: [1, 1],
        });
    });

    it('supports destructured polymorphic callback parameters', () => {
        expect(
            run(`${schema}
      interface Api {encode:<T>(value:T)=>Uint8Array;}
      function use<T>({encode:fn}:Api,value:T) {return fn<T>(value);}
      export const result=[...use<Msg>({encode},{value:7})];
    `).result,
        ).toEqual([8, 7]);
    });
    it('propagates object callback signatures through function parameters', () => {
        expect(
            run(`${schema}
      interface Api {encode:<T>(value:T)=>Uint8Array;}
      function use<T>(api:Api,value:T) {return api.encode<T>(value);}
      export const result=[...use<Msg>({encode},{value:7})];
    `).result,
        ).toEqual([8, 7]);
    });

    it('adapts typed assignments and callbacks stored in arrays', () => {
        expect(
            run(`${schema}
      type Encoder=(value:Msg)=>Uint8Array;
      let callback:Encoder;
      callback=encode;
      const callbacks:Encoder[]=[encode,callback];
      export const result=callbacks.map(fn=>[...fn({value:7})]);
    `).result,
        ).toEqual([
            [8, 7],
            [8, 7],
        ]);
    });

    it('reports opaque polymorphic consumers at build time', () => {
        expect(() =>
            run(`${schema}
      declare function external(fn:<T>(value:T)=>Uint8Array):void;
      external(encode);
    `),
        ).toThrow(/receiving implementation/);
    });
    it('supports class arrow fields as callbacks with lexical this', () => {
        expect(
            run(`${schema}
      class Codec<T> { calls=0; encode=(value:T)=>{this.calls++;return protobuf_encode<T>(value);}; }
      const codec=new Codec<Msg>();
      export const result=[{value:7}].map(codec.encode).map(bytes=>[...bytes]);
      export const calls=codec.calls;
    `),
        ).toEqual({ result: [[8, 7]], calls: 1 });
    });

    it('preserves spread evaluation, method receivers and rest arguments', () => {
        expect(
            run(`${schema}
      const events:string[]=[];
      const api={calls:0,send<T>(value:T,...labels:string[]){this.calls++;events.push(...labels);return protobuf_encode<T>(value);}};
      function args():[Msg,string,string] {events.push('args');return [{value:7},'a','b'];}
      export const result=[...api.send<Msg>(...args())];
      export const calls=api.calls;
      export {events};
    `),
        ).toEqual({ result: [8, 7], calls: 1, events: ['args', 'a', 'b'] });
    });
    it('analyzes shared higher order functions across multiple build entries', async () => {
        expect(
            await bundle(
                {
                    'apply.ts':
                        'export function apply<T>(value:T, callback:<U>(value:U)=>Uint8Array) { return callback<T>(value); }',
                    'plain.ts': `${imports} import {apply} from './apply'; interface Msg {value:pb<1,uint_32>;}
        function encode<T>(value:T) {return protobuf_encode<T>(value);}
        export const result=[...apply<Msg>({value:7},encode)];`,
                    'boxed.ts': `${imports} import {apply} from './apply'; interface Msg {value:pb<1,uint_32>;} interface Box<T> {value:pb<1,T>;}
        function encode<T>(value:T) {return protobuf_encode<Box<T>>({value});}
        export const result=[...apply<Msg>({value:8},encode)];`,
                },
                ['plain.ts', 'boxed.ts'],
            ),
        ).toEqual({ plain: { result: [8, 7] }, boxed: { result: [10, 2, 8, 8] } });
    });
    it('preserves this parameters, bound generic methods and class arguments', () => {
        expect(
            run(`${schema}
      interface Pair<T,U> {first:pb<1,T>;second:pb<2,U>;}
      class Codec<T> {
        calls=0;
        encode<U>(this:Codec<T>, value:Pair<T,U>) { this.calls++; return protobuf_encode<Pair<T,U>>(value); }
      }
      const codec = new Codec<uint_32>();
      const callback = codec.encode<string>.bind(codec);
      export const result = [...callback({first:7,second:'x'})];
      export const calls = codec.calls;
    `),
        ).toEqual({ result: [8, 7, 18, 1, 120], calls: 1 });
    });

    it('supports returned polymorphic functions and typed object callbacks', () => {
        expect(
            run(`${schema}
      type Encoder = <T>(value:T)=>Uint8Array;
      function factory(): Encoder { return encode; }
      const callback = factory();
      const api: {encode:Encoder} = {encode};
      export const result = [[...callback<Msg>({value:7})], [...api.encode<Msg>({value:8})], [...factory()<Msg>({value:9})]];
    `).result,
        ).toEqual([
            [8, 7],
            [8, 8],
            [8, 9],
        ]);
    });

    it('supports nested generic callback aliases', () => {
        expect(
            run(`${schema}
      type Callback<T> = (value:T)=>Uint8Array;
      type Alias<T> = Callback<T>;
      const callback: Alias<Msg> = encode;
      export const result = [...callback({value:7})];
    `).result,
        ).toEqual([8, 7]);
    });

    it('passes all required codecs when callback implementations differ', () => {
        expect(
            run(`${schema}
      interface Box<T> {value:pb<1,T>;}
      function boxed<T>(value:T) { return protobuf_encode<Box<T>>({value}); }
      function apply<T>(value:T, callback:<U>(value:U)=>Uint8Array) { return callback<T>(value); }
      export const result = [[...apply<Msg>({value:7}, encode)], [...apply<Msg>({value:8}, boxed)]];
    `).result,
        ).toEqual([
            [8, 7],
            [10, 2, 8, 8],
        ]);
    });

    it('supports a callback implementation accepting fewer parameters than its signature', () => {
        expect(
            run(`${schema}
      function apply(callback:<T>(value:T, index:number)=>Uint8Array) { return callback<Msg>({value:7}, 42); }
      export const result = [...apply(encode)];
    `).result,
        ).toEqual([8, 7]);
    });

    it('preserves default parameter evaluation and callback length', () => {
        expect(
            run(`${schema}
      let defaults=0;
      function callback<T>(value:T, flag=++defaults) { return flag ? protobuf_encode<T>(value) : new Uint8Array(); }
      const cb = callback<Msg>;
      export const result = [...cb({value:7})];
      export const length = cb.length;
      export {defaults};
    `),
        ).toEqual({ result: [8, 7], length: 1, defaults: 1 });
    });

    it('propagates nested schema substitutions through callback chains', () => {
        expect(
            run(`${schema}
      interface Box<T> {value:pb<1,T>;}
      function nested<T>(value:Box<T>) { return protobuf_encode<Box<T>>(value); }
      function apply<T>(value:Box<T>, fn:<U>(value:Box<U>)=>Uint8Array) { return fn<T>(value); }
      export const result = [...apply<Msg>({value:{value:7}}, nested)];
    `).result,
        ).toEqual([10, 2, 8, 7]);
    });

    it('preserves async callback bodies', async () => {
        const result = run(`${schema}
      async function send<T>(value:T) { await Promise.resolve(); return protobuf_encode<T>(value); }
      const values: Msg[] = [{value:7},{value:8}];
      export const result = Promise.all(values.map(send));
    `);
        expect((await result.result).map((bytes: Uint8Array) => [...bytes])).toEqual([
            [8, 7],
            [8, 8],
        ]);
    });
    it('materializes instantiation expressions in variables, returns and arrays', () => {
        expect(
            run(`${schema}
      const callback = encode<Msg>;
      function factory() { return encode<Msg>; }
      const values = [encode<Msg>, factory(), callback];
      export const result = values.map(fn => [...fn({value:7})]);
    `).result,
        ).toEqual([
            [8, 7],
            [8, 7],
            [8, 7],
        ]);
    });

    it('infers array callbacks and preserves side effects and rest arguments', () => {
        expect(
            run(`${schema}
      const values: Msg[] = [{value:7}, {value:8}];
      const calls: number[] = [];
      function callback<T>(value:T, ...rest: unknown[]) { calls.push(rest[0] as number); return protobuf_encode<T>(value); }
      export const result = values.map(callback).map(bytes => [...bytes]);
      export { calls };
    `),
        ).toEqual({
            result: [
                [8, 7],
                [8, 8],
            ],
            calls: [0, 1],
        });
    });

    it('adapts runtime function values directly', () => {
        expect(
            run(`${schema}
      const values: Msg[] = [{value:7}];
      const encodeMsg = protobuf_encode<Msg>;
      const decodeMsg: (bytes: Uint8Array) => Msg = protobuf_decode;
      export const result = [decodeMsg(encodeMsg(values[0])), ...values.map(protobuf_encode).map(decodeMsg)];
    `).result,
        ).toEqual([{ value: 7 }, { value: 7 }]);
    });

    it('passes codecs through a generic higher order function', () => {
        expect(
            run(`${schema}
      function apply<T>(value:T, callback:(value:T)=>Uint8Array) { return callback(value); }
      export const result = [...apply<Msg>({value:7}, encode)];
    `).result,
        ).toEqual([8, 7]);
    });

    it('supports independently generic callbacks and transitive forwarding', () => {
        expect(
            run(`${schema}
      type Encoder = <T>(value:T)=>Uint8Array;
      function invoke<T>(value:T, callback:Encoder) { return callback<T>(value); }
      function forward<T>(value:T, callback:Encoder) { return invoke<T>(value, callback); }
      export const result = [...forward<Msg>({value:7}, encode)];
    `).result,
        ).toEqual([8, 7]);
    });

    it('keeps distinct schemas when one generic callback is reused', () => {
        expect(
            run(`${schema}
      interface Text { value: pb<1,string>; }
      function both(callback:<T>(value:T)=>Uint8Array) {
        return [[...callback<Msg>({value:7})], [...callback<Text>({value:'x'})]];
      }
      export const result = both(encode);
    `).result,
        ).toEqual([
            [8, 7],
            [10, 1, 120],
        ]);
    });

    it('captures codecs in returned callbacks and contextual aliases', () => {
        expect(
            run(`${schema}
      type Encoder<T> = (value:T)=>Uint8Array;
      function factory<T>(): Encoder<T> { return encode; }
      const callback: Encoder<Msg> = encode;
      export const result = [[...callback({value:7})], [...factory<Msg>()({value:8})]];
    `).result,
        ).toEqual([
            [8, 7],
            [8, 8],
        ]);
    });

    it('supports generic inline callbacks and preserves native thisArg', () => {
        expect(
            run(`${schema}
      const values: Msg[] = [{value:7}];
      const state = { calls:0 };
      function callback<T>(value:T) { this.calls++; return protobuf_encode<T>(value); }
      export const a = values.map(callback, state).map(bytes => [...bytes]);
      export const b = values.map(<T>(value:T) => protobuf_encode<T>(value)).map(bytes => [...bytes]);
      export const calls = state.calls;
    `),
        ).toEqual({ a: [[8, 7]], b: [[8, 7]], calls: 1 });
    });

    it('handles imported higher order functions and callback aliases', async () => {
        expect(
            await bundle({
                'encoder.ts': `${imports} export function encode<T>(value:T) { return protobuf_encode<T>(value); }`,
                'apply.ts': `export function apply<T>(value:T, fn:<U>(value:U)=>Uint8Array) { return fn<T>(value); }`,
                'entry.ts': `import {encode as callback} from './encoder'; import {apply} from './apply'; interface Msg {value:pb<1,uint_32>;} export const result = [...apply<Msg>({value:7}, callback)];`,
            }),
        ).toEqual({ result: [8, 7] });
    });
});
