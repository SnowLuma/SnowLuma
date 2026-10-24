import { describe, expect, it } from 'vitest';
import { run } from '../compile';

const schema = 'interface Msg {id:pb<1,uint_32>; text:pb<2,string>;}';

describe('schema type transformations', () => {
    it('uses class parameter properties and ignores static metadata', () => {
        expect(
            run(`
      class Msg<T> {static label='message';constructor(public value:pb<1,T>) {}}
      export const result=protobuf_decode<Msg<uint_32>>(protobuf_encode<Msg<uint_32>>(new Msg<uint_32>(7)));
    `).result,
        ).toEqual({ value: 7 });
    });
    it('captures function generics in local schemas without mixing instantiations', () => {
        expect(
            run(`
      function encode<T>(value:T) { interface Local {value:pb<1,T>;} return protobuf_encode<Local>({value}); }
      export const result=[[...encode<uint_32>(7)], [...encode<string>('x')]];
    `).result,
        ).toEqual([
            [8, 7],
            [10, 1, 120],
        ]);
    });
    it('extracts schema types through infer, functions and promises', () => {
        expect(
            run(`${schema}
      type Result<T> = T extends (...args:any[])=>infer R ? R : never;
      type Unwrap<T> = T extends Promise<infer U> ? Unwrap<U> : T;
      type Schema = Unwrap<Result<(id:number)=>Promise<Promise<Msg>>>>;
      export const result = protobuf_decode<Schema>(protobuf_encode<Schema>({id:7,text:'x'}));
    `).result,
        ).toEqual({ id: 7, text: 'x' });
    });

    it('supports Awaited, ReturnType, Parameters and type queries', () => {
        expect(
            run(`${schema}
      function load(value:Msg): Promise<Msg> {return Promise.resolve(value);}
      type Result = Awaited<ReturnType<typeof load>>;
      type Input = Parameters<typeof load>[0];
      export const result = protobuf_decode<Result>(protobuf_encode<Input>({id:7,text:'x'}));
    `).result,
        ).toEqual({ id: 7, text: 'x' });
    });

    it('propagates deferred conditional transformations through generic functions', () => {
        expect(
            run(`${schema}
      type Unwrap<T> = T extends Promise<infer U> ? U : T;
      function encode<T>(value:Unwrap<T>) {return protobuf_encode<Unwrap<T>>(value);}
      export const result = protobuf_decode<Msg>(encode<Promise<Msg>>({id:7,text:'x'}));
    `).result,
        ).toEqual({ id: 7, text: 'x' });
    });

    it('remaps literal field names and omits never keys', () => {
        expect(
            run(`${schema}
      type Rename<T> = {[K in keyof T as K extends 'text' ? never : \`field_\${Capitalize<K>}\`]:T[K]};
      export const result = protobuf_decode<Rename<Msg>>(protobuf_encode<Rename<Msg>>({field_Id:7}));
    `).result,
        ).toEqual({ field_Id: 7 });
    });

    it('selects explicit schemas with Extract and Exclude', () => {
        expect(
            run(`${schema}
      type Schema = Extract<Msg|string,object>;
      type Chosen = Exclude<Msg|string,string>;
      export const result = protobuf_decode<Chosen>(protobuf_encode<Schema>({id:7,text:'x'}));
    `).result,
        ).toEqual({ id: 7, text: 'x' });
    });

    it('supports constructor signatures and indexed tuple transformations', () => {
        expect(
            run(`${schema}
      type Constructor = new(value:Msg)=>Msg;
      type Instance = InstanceType<Constructor>;
      type Input = ConstructorParameters<Constructor>[0];
      export const result = protobuf_decode<Instance>(protobuf_encode<Input>({id:7,text:'x'}));
    `).result,
        ).toEqual({ id: 7, text: 'x' });
    });
});
