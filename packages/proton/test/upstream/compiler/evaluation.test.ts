import { describe, expect, it } from 'vitest';
import { run } from '../compile';

const schema = 'interface Msg {value:pb<1,uint_32>;}';

describe('call evaluation', () => {
    it('preserves optional receiver short circuiting and single evaluation', () => {
        expect(
            run(`${schema}
      const events:string[]=[];
      class Codec {encode<T>(value:T) {events.push('encode');return protobuf_encode<T>(value);}}
      function get(present:boolean):Codec|undefined {events.push('get');return present ? new Codec() : undefined;}
      function argument():Msg {events.push('argument');return {value:7};}
      export const absent=get(false)?.encode<Msg>(argument());
      export const result=[...get(true)?.encode<Msg>(argument())!];
      export {events};
    `),
        ).toEqual({
            absent: undefined,
            result: [8, 7],
            events: ['get', 'get', 'argument', 'encode'],
        });
    });

    it('preserves getter receivers, multiple spreads and trailing commas', () => {
        expect(
            run(`${schema}
      const events:string[]=[];
      const codec={encode<T>(value:T,...labels:string[]) {events.push(...labels);return protobuf_encode<T>(value);}};
      const holder={get current(){events.push('get');return codec;}};
      function values():[Msg] {events.push('values');return [{value:7}];}
      function labels():string[] {events.push('labels');return ['a','b'];}
      export const result=[...holder.current.encode<Msg>(...values(),...labels(),)];
      export {events};
    `),
        ).toEqual({ result: [8, 7], events: ['get', 'values', 'labels', 'a', 'b'] });
    });

    it('evaluates constructor defaults before the body and preserves rest arguments', () => {
        expect(
            run(`${schema}
      const events:string[]=[];
      class Codec<T> {
        constructor(public value:T, public bytes=protobuf_encode<T>(value), ...labels:string[]) {events.push(...labels);}
        decode() {return protobuf_decode<T>(this.bytes);}
      }
      function args():[Msg,undefined,string,string] {events.push('args');return [{value:7},undefined,'a','b'];}
      const c=new Codec<Msg>(...args());
      export const result=c.decode(); export {events};
      export const length=Codec.length;
    `),
        ).toEqual({ result: { value: 7 }, events: ['args', 'a', 'b'], length: 1 });
    });

    it('preserves default codec calls in generic callback implementations', () => {
        expect(
            run(`${schema}
      function encode<T>(value:T, bytes=protobuf_encode<T>(value)) {return bytes;}
      function apply<T>(value:T, fn:<U>(value:U, bytes?:Uint8Array)=>Uint8Array) {return fn<T>(value);}
      export const result=[...apply<Msg>({value:7},encode)];
    `).result,
        ).toEqual([8, 7]);
    });

    it('supports generator and async generator bodies', async () => {
        const result = run(`${schema}
      function* encode<T>(value:T) {yield protobuf_encode<T>(value);}
      async function* later<T>(value:T) {yield protobuf_encode<T>(value);}
      export const result=[...encode<Msg>({value:7})].map(bytes=>[...bytes]);
      export const pending=later<Msg>({value:8}).next();
    `);
        expect(result.result).toEqual([[8, 7]]);
        expect([...(await result.pending).value]).toEqual([8, 8]);
    });
});
