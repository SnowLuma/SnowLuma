import type ts from 'typescript';

export interface TypeValue {
    kind:
        | 'primitive'
        | 'literal'
        | 'null'
        | 'parameter'
        | 'object'
        | 'marker'
        | 'union'
        | 'array'
        | 'tuple'
        | 'function'
        | 'constructor'
        | 'promise'
        | 'inference'
        | 'lazy'
        | 'deferred';
    key: string;
    name: string;
    dynamic: boolean;
    fields?: Map<string, { type: TypeValue; optional: boolean; node: ts.Node }>;
    values?: TypeValue[];
    fieldNumber?: number;
    repeated?: boolean;
    explicitPresence?: boolean;
    origin?: { node: ts.TypeNode; source: ts.SourceFile; env: TypeEnvironment };
    application?: { declaration: ts.Declaration; arguments: TypeValue[] };
}
export type TypeEnvironment = Map<string, TypeValue>;

export const value = (kind: TypeValue['kind'], name: string, key = name): TypeValue => ({
    kind,
    key,
    name,
    dynamic: kind === 'parameter',
});
