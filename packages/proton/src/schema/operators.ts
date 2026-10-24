import ts from 'typescript';
import { fail } from '../source/context.js';
import type { SchemaResolver } from './resolver.js';
import { assignable } from './relations.js';
import { value, type TypeEnvironment, type TypeValue } from './types.js';

const utilities = new Set([
    'Promise',
    'Awaited',
    'ReturnType',
    'Parameters',
    'InstanceType',
    'ConstructorParameters',
    'Extract',
    'Exclude',
    'Uppercase',
    'Lowercase',
    'Capitalize',
    'Uncapitalize',
]);

function container(kind: TypeValue['kind'], values: TypeValue[]): TypeValue {
    return {
        kind,
        values,
        key: `${kind}<${values.map((type) => type.key)}>`,
        name: kind,
        dynamic: values.some((type) => type.dynamic),
    };
}

export function resolveOperator(
    node: ts.TypeNode,
    source: ts.SourceFile,
    env: TypeEnvironment,
    resolver: SchemaResolver,
): TypeValue | undefined {
    if (
        ts.isTypeReferenceNode(node) &&
        (!ts.isIdentifier(node.typeName) || !utilities.has(node.typeName.text))
    ) {
        return;
    }

    const resolve = (type: ts.TypeNode) => resolver.type(type, type.getSourceFile(), env);

    if (ts.isInferTypeNode(node)) {
        return value('inference', node.typeParameter.name.text);
    }

    if (ts.isTupleTypeNode(node)) {
        return container(
            'tuple',
            node.elements.map((type) => resolve(ts.isNamedTupleMember(type) ? type.type : type)),
        );
    }

    if (ts.isOptionalTypeNode(node)) {
        return container('union', [resolve(node.type), value('null', 'undefined')]);
    }

    if (ts.isRestTypeNode(node)) {
        return resolve(node.type);
    }

    if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) {
        const local = new Map(env);

        for (const param of node.typeParameters ?? []) {
            local.set(param.name.text, resolver.parameter(param.name.text, node));
        }

        const parameters = node.parameters.filter(
            (param) => !ts.isIdentifier(param.name) || param.name.text !== 'this',
        );
        return container(ts.isFunctionTypeNode(node) ? 'function' : 'constructor', [
            container(
                'tuple',
                parameters.map((param) =>
                    param.type
                        ? resolver.type(param.type, source, local)
                        : value('primitive', 'unknown'),
                ),
            ),
            resolver.type(node.type, source, local),
        ]);
    }

    if (ts.isTypeQueryNode(node)) {
        const ref = ts.isIdentifier(node.exprName)
            ? resolver.context.lookup(node.exprName.text, node.exprName, source)
            : resolver.context.typeName(node.exprName, source);
        const declaration = ref?.node;

        if (declaration && (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))) {
            if (declaration.type) {
                return resolve(declaration.type);
            }

            const initializer = declaration.initializer;

            if (
                initializer &&
                (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))
            ) {
                return resolve(initializer.type);
            }
        }

        if (declaration && ts.isFunctionDeclaration(declaration) && declaration.type) {
            return container('function', [
                container(
                    'tuple',
                    declaration.parameters.map((param) =>
                        param.type ? resolve(param.type) : value('primitive', 'unknown'),
                    ),
                ),
                resolve(declaration.type),
            ]);
        }

        fail(
            node,
            'Type queries used in schemas require an explicit variable or function return annotation.',
        );
    }

    if (ts.isTemplateLiteralTypeNode(node)) {
        let strings = [node.head.text];

        for (const span of node.templateSpans) {
            const type = resolve(span.type);

            if (type.dynamic) {
                return resolver.defer(node, source, env);
            }

            const options = type.kind === 'union' ? type.values! : [type];

            if (options.some((type) => type.kind !== 'literal')) {
                fail(node, 'Template schema keys require literal types.');
            }

            strings = strings.flatMap((prefix) =>
                options.map((type) => prefix + type.name + span.literal.text),
            );

            if (strings.length > 128) {
                fail(node, 'Template type expansion exceeds 128 keys.');
            }
        }

        const literals = strings.map((text) => value('literal', text, JSON.stringify(text)));
        return literals.length === 1 ? literals[0] : container('union', literals);
    }

    if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) {
        return;
    }

    const name = node.typeName.text;

    if (!utilities.has(name) || resolver.context.typeName(node.typeName, source)) {
        return;
    }

    const args = node.typeArguments;

    if (!args?.length) {
        fail(node, `${name} requires a type argument.`);
    }

    const operand = resolve(args[0]);

    if (name === 'Promise') {
        return container('promise', [operand]);
    }

    if (operand.dynamic) {
        return resolver.defer(node, source, env);
    }

    if (name === 'Awaited') {
        const unwrap = (type: TypeValue): TypeValue =>
            type.kind === 'promise'
                ? unwrap(type.values![0])
                : type.kind === 'union'
                  ? container('union', type.values!.map(unwrap))
                  : type;
        return unwrap(operand);
    }

    if (['ReturnType', 'Parameters', 'InstanceType', 'ConstructorParameters'].includes(name)) {
        const expected =
            name === 'InstanceType' || name === 'ConstructorParameters'
                ? 'constructor'
                : 'function';

        if (operand.kind !== expected) {
            fail(node, `${name} requires a ${expected} type.`);
        }

        return operand.values![name.endsWith('Parameters') ? 0 : 1];
    }

    if (name === 'Extract' || name === 'Exclude') {
        if (!args[1]) {
            fail(node, `${name} requires two type arguments.`);
        }

        const constraint = resolve(args[1]);

        if (constraint.dynamic) {
            return resolver.defer(node, source, env);
        }

        const selected = (operand.kind === 'union' ? operand.values! : [operand]).filter(
            (type) => assignable(type, constraint) === (name === 'Extract'),
        );
        return selected.length === 0
            ? value('primitive', 'never')
            : selected.length === 1
              ? selected[0]
              : container('union', selected);
    }

    const transform = (type: TypeValue): TypeValue => {
        if (type.kind !== 'literal' || !/^["']/.test(type.key)) {
            fail(node, `${name} requires literal string keys.`);
        }

        const text =
            name === 'Uppercase'
                ? type.name.toUpperCase()
                : name === 'Lowercase'
                  ? type.name.toLowerCase()
                  : (name === 'Capitalize'
                        ? (type.name[0] ?? '').toUpperCase()
                        : (type.name[0] ?? '').toLowerCase()) + type.name.slice(1);
        return value('literal', text, JSON.stringify(text));
    };

    return operand.kind === 'union'
        ? container('union', operand.values!.map(transform))
        : transform(operand);
}
