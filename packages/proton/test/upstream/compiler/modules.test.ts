import { bundle } from '../project';
import { describe, expect, it } from 'vitest';
import { imports } from '../compile';

describe('module graph', () => {
    it('resolves nested imported schemas and renamed exports', async () => {
        expect(
            await bundle({
                'inner.ts': 'export interface Inner {value:pb<1,uint_32>;} ',
                'outer.ts':
                    "import type {Inner} from './inner'; export interface Outer {inner:pb<1,Inner>;}",
                'barrel.ts': "export {Outer as Message} from './outer';",
                'entry.ts': `${imports} import type {Message as Msg} from './barrel'; export const result = protobuf_decode<Msg>(protobuf_encode<Msg>({inner:{value:7}}));`,
            }),
        ).toEqual({ result: { inner: { value: 7 } } });
    });

    it('keeps wrapper control flow, object receivers and transitive generic aliases', async () => {
        expect(
            await bundle({
                'schema.ts':
                    'export interface Box<T> {value:pb<1,T>;} export type Message<T> = Box<Box<T>>;',
                'codec.ts': `${imports} import type {Message} from './schema';
        export const api = { count:0, encode<T>(value:Message<T>, enabled=true) {
          this.count++; if (!enabled) return new Uint8Array();
          const inner = () => protobuf_encode<Message<T>>(value); return inner();
        }};`,
                'entry.ts': `${imports} import {api} from './codec'; import type {Message} from './schema';
        export const result = protobuf_decode<Message<string>>(api.encode<string>({value:{value:'x'}}));
        export const empty = api.encode<string>({value:{value:'x'}}, false).length;
        export const count = api.count;`,
            }),
        ).toEqual({ result: { value: { value: 'x' } }, empty: 0, count: 2 });
    });

    it('handles recursive types across modules', async () => {
        expect(
            await bundle({
                'a.ts': "import type {B} from './b'; export interface A {value:pb<1,uint_32>; next?:pb<2,B>;}",
                'b.ts': "import type {A} from './a'; export interface B {text:pb<1,string>; next?:pb<2,A>;}",
                'entry.ts': `${imports} import type {A} from './a'; export const result = protobuf_decode<A>(protobuf_encode<A>({value:7,next:{text:'x'}}));`,
            }),
        ).toEqual({ result: { value: 7, next: { text: 'x', next: null } } });
    });

    it('resolves nested generic functions with non-first schema parameters', async () => {
        expect(
            await bundle({
                'codec.ts': `${imports} export function send<Context,T>(context:Context, value:T) { if (!context) throw new Error('context'); return protobuf_encode<T>(value); }`,
                'entry.ts': `import {send} from './codec'; interface Msg {value:pb<1,uint_32>;} export const result = [...send<string,Msg>('ok',{value:7})];`,
            }),
        ).toEqual({ result: [8, 7] });
    });
});
