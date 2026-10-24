import ts from 'typescript';
import { fail, type DeclarationRef } from '../source/context.js';
import type { SchemaResolver } from './resolver.js';
import { value, type TypeEnvironment, type TypeValue } from './types.js';

export class ObjectTypes {
    private readonly types = new Map<string, TypeValue>();
    private readonly aliases = new Set<string>();
    private readonly concrete = new WeakMap<ts.Node, TypeValue>();
    private readonly bases = new Set<string>();

    constructor(private readonly resolver: SchemaResolver) {}

    declaration(
        ref: DeclarationRef,
        args: readonly ts.TypeNode[],
        caller: ts.SourceFile,
        env: TypeEnvironment,
        origin: ts.TypeNode,
        heritage = false,
    ): TypeValue {
        const node = ref.node;

        if (
            !ts.isInterfaceDeclaration(node) &&
            !ts.isTypeAliasDeclaration(node) &&
            !ts.isClassDeclaration(node)
        ) {
            fail(origin, 'Expected an interface, type alias or class schema.');
        }

        const concrete = !node.typeParameters?.length && ts.isSourceFile(node.parent);
        const previous = concrete && this.concrete.get(node);

        if (previous && heritage && this.bases.has(previous.key)) {
            fail(origin, 'Circular schema inheritance.');
        }

        if (previous) {
            return previous;
        }

        const local = this.resolver.arguments(node.typeParameters, args, caller, env, node);

        for (let scope = node.parent; scope; scope = scope.parent) {
            if (!ts.isFunctionLike(scope) && !ts.isClassDeclaration(scope)) {
                continue;
            }

            for (const parameter of scope.typeParameters ?? []) {
                const name = parameter.name.text;

                if (!local.has(name)) {
                    local.set(name, env.get(name) ?? this.resolver.parameter(name, scope));
                }
            }
        }

        const parameters = [...local.values()];
        const key = `${ref.source.fileName}:${node.pos}<${parameters.map((type) => type.key).join(',')}>`;

        if (heritage && this.bases.has(key)) {
            fail(origin, 'Circular schema inheritance.');
        }

        if (heritage && this.bases.size >= 128) {
            fail(origin, 'Schema inheritance exceeds 128 levels.');
        }

        const cached = this.types.get(key);

        if (cached) {
            return cached;
        }

        if (ts.isTypeAliasDeclaration(node)) {
            if (ts.isTypeLiteralNode(node.type)) {
                const result = this.object(
                    node.name.text + parameters.map((type) => '__' + type.name).join(''),
                    key,
                );
                result.origin = { node: origin, source: caller, env: new Map(env) };

                if (parameters.length) {
                    result.application = { declaration: node, arguments: parameters };
                }

                this.types.set(key, result);

                if (concrete) {
                    this.concrete.set(node, result);
                }

                return this.members(node.type.members, result, ref.source, local);
            }

            if (this.aliases.has(key)) {
                fail(node, 'Circular type alias.');
            }

            this.aliases.add(key);

            try {
                const result = this.resolver.type(node.type, ref.source, local);
                this.types.set(key, result);

                if (concrete) {
                    this.concrete.set(node, result);
                }

                return result;
            } finally {
                this.aliases.delete(key);
            }
        }

        const name =
            (node.name?.text ?? 'Default') + parameters.map((type) => '__' + type.name).join('');
        const result = this.object(name, key);
        result.dynamic = parameters.some((type) => type.dynamic);

        if (parameters.length) {
            result.application = { declaration: node, arguments: parameters };
        }

        result.origin = { node: origin, source: caller, env: new Map(env) };
        this.types.set(key, result);

        if (concrete) {
            this.concrete.set(node, result);
        }

        this.bases.add(key);

        try {
            for (const clause of node.heritageClauses ?? []) {
                if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
                    continue;
                }

                for (const base of clause.types) {
                    const declaration = this.resolver.context.reference(
                        base.expression,
                        ref.source,
                        true,
                    );

                    if (!declaration) {
                        fail(base, 'Unresolved base schema.');
                    }

                    this.merge(
                        result,
                        this.declaration(
                            declaration,
                            base.typeArguments ?? [],
                            ref.source,
                            local,
                            origin,
                            true,
                        ),
                        base,
                    );
                }
            }
        } finally {
            this.bases.delete(key);
        }

        return this.members(node.members, result, ref.source, local);
    }

    members(
        members: ts.NodeArray<ts.TypeElement | ts.ClassElement>,
        result: TypeValue,
        source: ts.SourceFile,
        env: TypeEnvironment,
    ): TypeValue {
        const fields = members.flatMap<ts.TypeElement | ts.ClassElement | ts.ParameterDeclaration>(
            (member) =>
                ts.isConstructorDeclaration(member)
                    ? member.parameters.filter((parameter) =>
                          parameter.modifiers?.some((modifier) =>
                              [
                                  ts.SyntaxKind.PublicKeyword,
                                  ts.SyntaxKind.PrivateKeyword,
                                  ts.SyntaxKind.ProtectedKeyword,
                                  ts.SyntaxKind.ReadonlyKeyword,
                              ].includes(modifier.kind),
                          ),
                      )
                    : [member],
        );

        for (const member of fields) {
            if (
                !ts.isPropertySignature(member) &&
                !ts.isPropertyDeclaration(member) &&
                !ts.isParameter(member)
            ) {
                continue;
            }

            if (
                member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
            ) {
                continue;
            }

            if (!member.type || !member.name || ts.isComputedPropertyName(member.name)) {
                fail(member, 'Schema fields require static names and explicit field markers.');
            }

            const name =
                ts.isIdentifier(member.name) ||
                ts.isStringLiteral(member.name) ||
                ts.isNumericLiteral(member.name)
                    ? member.name.text
                    : fail(member, 'Unsupported field name.');
            const type = this.resolver.type(member.type, source, env);
            result.fields!.set(name, { type, optional: !!member.questionToken, node: member });
            result.dynamic ||= type.dynamic;
        }

        return result;
    }

    merge(target: TypeValue, source: TypeValue, node: ts.Node): void {
        if (!source.fields) {
            fail(node, 'Schema intersections and bases must be object types.');
        }

        for (const [name, property] of source.fields) {
            const existing = target.fields!.get(name);

            if (existing && existing.type.key !== property.type.key) {
                fail(node, `Conflicting inherited field ${name}.`);
            }

            target.fields!.set(name, property);
        }

        target.dynamic ||= source.dynamic;
    }

    object(name: string, key: string): TypeValue {
        return { ...value('object', name, key), fields: new Map() };
    }
}
