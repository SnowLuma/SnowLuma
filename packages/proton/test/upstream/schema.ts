import ts from 'typescript';
import { SourceContext } from '../../src/source/context';
import { SchemaResolver } from '../../src/schema/resolver';
import { generateCode } from '../../src/codegen/generator';

export function schemaCodecs<T>(code: string, name = 'Msg') {
    const generated = generateCode(schemaRegistry(code));
    return new Function(
        `${generated}\nreturn { encode: protobuf_encode_${name}, decode: protobuf_decode_${name} };`,
    )() as {
        encode(value: T): Uint8Array;
        decode(bytes: Uint8Array): T;
    };
}

export function schemaRegistry(code: string, file = 'schema.ts') {
    const context = new SourceContext();
    const source = context.source(file, code);
    const resolver = new SchemaResolver(context);
    const roots: string[] = [];

    for (const statement of source.statements) {
        if (ts.isInterfaceDeclaration(statement) && !statement.typeParameters?.length) {
            roots.push(statement.name.text);
        }
    }

    const expanded = context.source(
        file,
        code + roots.map((name, i) => `\ntype __TestRoot${i} = ${name};`).join(''),
    );

    for (const statement of expanded.statements) {
        if (ts.isTypeAliasDeclaration(statement) && statement.name.text.startsWith('__TestRoot')) {
            resolver.message(resolver.type(statement.type), statement);
        }
    }

    return resolver.registry;
}
