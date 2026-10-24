import { packageName } from '../package.js';
import ts from 'typescript';
import { SourceContext, fail, runtimeImportName } from '../source/context.js';
import { PRIMITIVE_TYPE_MAP } from '../codegen/model.js';

import { value, type TypeEnvironment, type TypeValue } from './types.js';
import { MessageBuilder } from './message.js';
import { matchInferred } from './relations.js';
import { resolveOperator } from './operators.js';
import { ObjectTypes } from './objects.js';

const primitiveNames = new Set(Object.keys(PRIMITIVE_TYPE_MAP));

/** Lazily resolves only types reached by codec calls; no project-wide type checker. */
export class SchemaResolver {
    private readonly messages = new MessageBuilder();
    readonly registry = this.messages.registry;
    private readonly objects = new ObjectTypes(this);
    private depth = 0;
    private readonly resolvedLazy = new WeakMap<TypeValue, TypeValue>();

    constructor(readonly context: SourceContext) {}

    parameter(name: string, owner: ts.Node): TypeValue {
        return value('parameter', name, `${owner.getSourceFile().fileName}:${owner.pos}:${name}`);
    }

    substitute(type: TypeValue, bindings: Map<string, TypeValue>): TypeValue {
        if (type.kind === 'lazy') {
            const { node, source, env } = type.origin!;
            return this.lazy(
                node,
                source,
                new Map([...env].map(([name, val]) => [name, this.substitute(val, bindings)])),
            );
        }

        if (!type.dynamic) {
            return type;
        }

        if (type.kind === 'parameter') {
            return bindings.get(type.key) ?? type;
        }

        if (type.origin) {
            const { node, source, env } = type.origin;
            return this.type(
                node,
                source,
                new Map([...env].map(([name, val]) => [name, this.substitute(val, bindings)])),
            );
        }

        return type;
    }

    type(
        node: ts.TypeNode,
        source = node.getSourceFile(),
        env: TypeEnvironment = new Map(),
    ): TypeValue {
        if (++this.depth > 128) {
            this.depth--;
            return fail(
                node,
                'Type expansion exceeds 128 levels (possibly an expanding recursive generic).',
            );
        }

        try {
            const result = this.resolve(node, source, env);

            if (result.dynamic && result.kind !== 'parameter' && !result.origin) {
                result.origin = { node, source, env: new Map(env) };
            }

            return result;
        } finally {
            this.depth--;
        }
    }

    arguments(
        params: readonly ts.TypeParameterDeclaration[] | undefined,
        args: readonly ts.TypeNode[] | undefined,
        source: ts.SourceFile,
        outer: TypeEnvironment,
        declaration: ts.Node,
        lazy = false,
    ): TypeEnvironment {
        const result = new Map<string, TypeValue>();

        if ((args?.length ?? 0) > (params?.length ?? 0)) {
            fail(declaration, 'Too many generic type arguments.');
        }

        for (let i = 0; i < (params?.length ?? 0); i++) {
            const param = params![i];
            const arg = args?.[i];
            const resolved = arg
                ? lazy
                    ? this.lazy(arg, source, outer)
                    : this.type(arg, source, outer)
                : param.default
                  ? lazy
                      ? this.lazy(param.default, declaration.getSourceFile(), result)
                      : this.type(param.default, declaration.getSourceFile(), result)
                  : undefined;

            if (!resolved) {
                fail(declaration, `Missing concrete type argument for ${param.name.text}.`);
            }

            result.set(param.name.text, resolved);
        }

        return result;
    }

    message(type: TypeValue, node: ts.Node): string {
        return this.messages.build(this.materialize(type), node);
    }

    /** Receiver discovery carries application types without expanding them until
     * a protobuf requirement actually consumes the binding. */
    lazy(node: ts.TypeNode, source: ts.SourceFile, env: TypeEnvironment): TypeValue {
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
            const bound = env.get(node.typeName.text);

            if (bound) {
                return bound;
            }

            if (primitiveNames.has(node.typeName.text)) {
                return this.type(node, source, env);
            }
        }

        const mentionsParameter = (child: ts.Node): boolean =>
            (ts.isIdentifier(child) && env.get(child.text)?.dynamic === true) ||
            (ts.forEachChild(child, mentionsParameter) ?? false);

        return {
            ...value(
                'lazy',
                node.getText(source),
                `lazy:${source.fileName}:${node.getText(source)}<${[...env.values()].map((v) => v.key)}>`,
            ),
            dynamic: mentionsParameter(node),
            origin: { node, source, env: new Map(env) },
        };
    }

    private materialize(type: TypeValue): TypeValue {
        if (type.kind !== 'lazy') {
            return type;
        }

        const cached = this.resolvedLazy.get(type);

        if (cached) {
            return cached;
        }

        const { node, source, env } = type.origin!;
        const resolved = this.type(node, source, env);
        this.resolvedLazy.set(type, resolved);
        return resolved;
    }

    private resolve(node: ts.TypeNode, source: ts.SourceFile, env: TypeEnvironment): TypeValue {
        if (ts.isTypeReferenceNode(node)) {
            return this.reference(node, source, env);
        }

        const operator = resolveOperator(node, source, env, this);

        if (operator) {
            return operator;
        }

        if (ts.isParenthesizedTypeNode(node)) {
            return this.type(node.type, source, env);
        }

        if (node.kind === ts.SyntaxKind.StringKeyword) {
            return value('primitive', 'string');
        }

        if (node.kind === ts.SyntaxKind.BooleanKeyword) {
            return value('primitive', 'bool');
        }

        if (
            [
                ts.SyntaxKind.ObjectKeyword,
                ts.SyntaxKind.NumberKeyword,
                ts.SyntaxKind.BigIntKeyword,
                ts.SyntaxKind.AnyKeyword,
                ts.SyntaxKind.UnknownKeyword,
                ts.SyntaxKind.NeverKeyword,
            ].includes(node.kind)
        ) {
            return value('primitive', node.getText(source));
        }

        if (
            node.kind === ts.SyntaxKind.UndefinedKeyword ||
            node.kind === ts.SyntaxKind.VoidKeyword
        ) {
            return value('null', 'undefined');
        }

        if (ts.isLiteralTypeNode(node)) {
            if (node.literal.kind === ts.SyntaxKind.NullKeyword) {
                return value('null', 'null');
            }

            if (ts.isStringLiteral(node.literal)) {
                return value('literal', node.literal.text, JSON.stringify(node.literal.text));
            }

            return value('literal', node.literal.getText(source));
        }

        if (ts.isArrayTypeNode(node)) {
            return this.container(
                'array',
                [this.type(node.elementType, source, env)],
                node,
                source,
                env,
            );
        }

        if (ts.isUnionTypeNode(node)) {
            const members = [
                ...new Map(
                    node.types
                        .flatMap((item) => {
                            const type = this.type(item, source, env);
                            return type.kind === 'union' ? type.values! : [type];
                        })
                        .map((item) => [item.key, item]),
                ).values(),
            ];
            return members.length === 1
                ? members[0]
                : this.container('union', members, node, source, env);
        }

        if (ts.isIntersectionTypeNode(node)) {
            const members = node.types.map((item) => this.type(item, source, env));

            if (members.some((item) => item.dynamic && item.kind !== 'object')) {
                return this.defer(node, source, env);
            }

            const result = this.objects.object(
                'Intersection',
                members.map((item) => item.key).join('&'),
            );

            for (const member of members) {
                this.objects.merge(result, member, node);
            }

            return result;
        }

        if (ts.isTypeLiteralNode(node)) {
            return this.objects.members(
                node.members,
                this.objects.object(
                    'Anonymous',
                    `${source.fileName}:${node.pos}<${[...env.values()].map((type) => type.key)}>`,
                ),
                source,
                env,
            );
        }

        if (ts.isTypeOperatorNode(node)) {
            const operand = this.type(node.type, source, env);

            if (node.operator === ts.SyntaxKind.ReadonlyKeyword) {
                return operand;
            }

            if (operand.dynamic && !operand.fields) {
                return this.defer(node, source, env);
            }

            if (node.operator === ts.SyntaxKind.KeyOfKeyword && operand.fields) {
                return this.container(
                    'union',
                    [...operand.fields.keys()].map((key) =>
                        value('literal', key, JSON.stringify(key)),
                    ),
                    node,
                    source,
                    env,
                );
            }
        }

        if (ts.isIndexedAccessTypeNode(node)) {
            const object = this.type(node.objectType, source, env);
            const index = this.type(node.indexType, source, env);

            if (object.dynamic || index.dynamic) {
                return this.defer(node, source, env);
            }

            const keys = index.kind === 'union' ? index.values! : [index];
            const values = keys.map(
                (key) =>
                    object.fields?.get(key.name)?.type ??
                    (object.kind === 'tuple'
                        ? object.values?.[Number(key.name)]
                        : object.kind === 'array'
                          ? object.values?.[0]
                          : undefined) ??
                    fail(node, `Unknown indexed property ${key.name}.`),
            );
            return values.length === 1
                ? values[0]
                : this.container('union', values, node, source, env);
        }

        if (ts.isConditionalTypeNode(node)) {
            const check = this.type(node.checkType, source, env);
            const constraint = this.type(node.extendsType, source, env);

            if (check.dynamic || constraint.dynamic) {
                return this.defer(node, source, env);
            }

            if (
                check.kind === 'union' &&
                ts.isTypeReferenceNode(node.checkType) &&
                ts.isIdentifier(node.checkType.typeName) &&
                env.has(node.checkType.typeName.text)
            ) {
                const results = check.values!.map((type) =>
                    this.type(
                        node,
                        source,
                        new Map(env).set(
                            (node.checkType as ts.TypeReferenceNode).typeName.getText(source),
                            type,
                        ),
                    ),
                );
                const distinct = [...new Map(results.map((type) => [type.key, type])).values()];
                return distinct.length === 1
                    ? distinct[0]
                    : this.container('union', distinct, node, source, env);
            }

            const inferred = new Map<string, TypeValue>();
            const matches = matchInferred(check, constraint, inferred);
            return this.type(
                matches ? node.trueType : node.falseType,
                source,
                new Map([...env, ...inferred]),
            );
        }

        if (ts.isMappedTypeNode(node) && node.type && node.typeParameter.constraint) {
            const keys = this.type(node.typeParameter.constraint, source, env);

            if (keys.dynamic) {
                return this.defer(node, source, env);
            }

            const result = this.objects.object(
                'Mapped',
                `${source.fileName}:${node.pos}<${[...env.values()].map((v) => v.key)}>`,
            );

            for (const key of keys.kind === 'union' ? keys.values! : [keys]) {
                const local = new Map(env).set(node.typeParameter.name.text, key);
                const remapped = node.nameType ? this.type(node.nameType, source, local) : key;

                if (remapped.name === 'never') {
                    continue;
                }

                const inherited = ts.isIndexedAccessTypeNode(node.type)
                    ? (this.type(node.type.objectType, source, local).fields?.get(key.name)
                          ?.optional ?? false)
                    : false;
                const optional = node.questionToken
                    ? node.questionToken.kind !== ts.SyntaxKind.MinusToken
                    : inherited;

                for (const name of remapped.kind === 'union' ? remapped.values! : [remapped]) {
                    result.fields!.set(name.name, {
                        type: this.type(node.type, source, local),
                        optional,
                        node,
                    });
                }
            }

            return result;
        }

        fail(node, `Unsupported or ambiguous type expression ${node.getText(source)}.`);
    }

    private reference(
        node: ts.TypeReferenceNode,
        source: ts.SourceFile,
        env: TypeEnvironment,
    ): TypeValue {
        const simple = ts.isIdentifier(node.typeName) ? node.typeName.text : undefined;

        if (simple && env.has(simple)) {
            return this.materialize(env.get(simple)!);
        }

        const operator = resolveOperator(node, source, env, this);

        if (operator) {
            return operator;
        }

        const ref = this.context.typeName(node.typeName, source);
        let name = simple
            ? (ref && runtimeImportName(ref.node)) || simple
            : node.typeName.getText(source);

        if (ts.isQualifiedName(node.typeName) && ts.isIdentifier(node.typeName.left)) {
            const namespace = this.context.lookup(node.typeName.left.text, node, source, true);

            if (
                namespace &&
                ts.isNamespaceImport(namespace.node) &&
                (namespace.node.parent.parent.moduleSpecifier as ts.StringLiteral).text ===
                    packageName
            ) {
                name = node.typeName.right.text;
            }
        }

        const args = node.typeArguments ?? [];

        if (
            ref &&
            (ts.isImportSpecifier(ref.node) || ts.isImportClause(ref.node)) &&
            !runtimeImportName(ref.node)
        ) {
            fail(node, `Unresolved imported type ${name}.`);
        }

        if (
            ref &&
            !runtimeImportName(ref.node) &&
            !ts.isImportSpecifier(ref.node) &&
            !ts.isNamespaceImport(ref.node)
        ) {
            return this.objects.declaration(ref, args, source, env, node);
        }

        if (primitiveNames.has(name)) {
            return value('primitive', name);
        }

        if (name === 'pb' || name === 'pb_repeated' || name === 'pb_optional') {
            if (args.length !== 2) {
                fail(node, `${name} requires a field number and a field type.`);
            }

            const fieldNumber = this.type(args[0], source, env);
            const payload = this.type(args[1], source, env);
            const marker = this.container('marker', [payload], node, source, env);
            return {
                ...marker,
                key: `${name}:${marker.key}:${fieldNumber.key}`,
                dynamic: fieldNumber.dynamic || marker.dynamic,
                fieldNumber: Number(fieldNumber.name),
                repeated: name === 'pb_repeated',
                explicitPresence: name === 'pb_optional',
            };
        }

        if (name === 'Array' || name === 'ReadonlyArray') {
            return this.container('array', [this.type(args[0], source, env)], node, source, env);
        }

        if (['Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'NonNullable'].includes(name)) {
            const operand = this.type(args[0], source, env);

            if (operand.dynamic) {
                return this.defer(node, source, env);
            }

            if (name === 'Readonly') {
                return operand;
            }

            if (name === 'NonNullable') {
                const members =
                    operand.kind === 'union'
                        ? operand.values!.filter((item) => item.kind !== 'null')
                        : [operand];
                return members.length === 1
                    ? members[0]
                    : this.container('union', members, node, source, env);
            }

            if (!operand.fields) {
                fail(node, `${name} requires an object type.`);
            }

            const keys = args[1] ? this.type(args[1], source, env) : undefined;
            const selected = new Set(
                keys ? (keys.kind === 'union' ? keys.values! : [keys]).map((key) => key.name) : [],
            );

            if (name === 'Pick') {
                for (const key of selected) {
                    if (!operand.fields.has(key)) {
                        fail(node, `Unknown Pick property ${key}.`);
                    }
                }
            }

            const result = this.objects.object(
                `${name}__${operand.name}`,
                `${name}<${operand.key},${keys?.key ?? ''}>`,
            );

            for (const [key, property] of operand.fields) {
                if (
                    (name === 'Pick' && !selected.has(key)) ||
                    (name === 'Omit' && selected.has(key))
                ) {
                    continue;
                }

                result.fields!.set(key, {
                    ...property,
                    optional: name === 'Partial' || (name !== 'Required' && property.optional),
                });
            }

            return result;
        }

        if (ref) {
            return this.objects.declaration(ref, args, source, env, node);
        }

        fail(node, `Unresolved type ${name}.`);
    }

    defer(node: ts.TypeNode, source: ts.SourceFile, env: TypeEnvironment): TypeValue {
        return {
            ...value(
                'deferred',
                node.getText(source),
                `${source.fileName}:${node.pos}<${[...env.values()].map((v) => v.key)}>`,
            ),
            dynamic: true,
            origin: { node, source, env: new Map(env) },
        };
    }
    private container(
        kind: TypeValue['kind'],
        values: TypeValue[],
        node: ts.TypeNode,
        source: ts.SourceFile,
        env: TypeEnvironment,
    ): TypeValue {
        if (kind === 'union') {
            values = values.filter((type) => type.name !== 'never');

            if (!values.length) {
                return value('primitive', 'never');
            }

            if (values.length === 1) {
                return values[0];
            }
        }

        return {
            kind,
            name: values.map((type) => type.name).join('__'),
            key: `${kind}<${JSON.stringify(values.map((type) => type.key))}>`,
            values,
            dynamic: values.some((type) => type.dynamic),
            origin: { node, source, env: new Map(env) },
        };
    }
}
