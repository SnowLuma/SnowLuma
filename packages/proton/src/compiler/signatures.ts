import ts from 'typescript';
import type { SourceContext } from '../source/context.js';
import type { SchemaResolver } from '../schema/resolver.js';
import type { TypeEnvironment } from '../schema/types.js';

export interface Signature {
    node: ts.FunctionTypeNode | ts.CallSignatureDeclaration;
    env: TypeEnvironment;
}

export function memberType(
    type: ts.TypeNode,
    name: string,
    env: TypeEnvironment,
    context: SourceContext,
    resolver: SchemaResolver,
    seen = new Set<ts.Node>(),
): { type: ts.TypeNode; env: TypeEnvironment } | undefined {
    if (seen.has(type)) {
        return;
    }

    seen.add(type);

    if (ts.isTypeLiteralNode(type)) {
        const member = type.members.find(
            (member) =>
                member.name &&
                (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
                member.name.text === name,
        );
        return member && ts.isPropertySignature(member) && member.type
            ? { type: member.type, env }
            : undefined;
    }

    if (ts.isTypeReferenceNode(type)) {
        const ref = context.typeName(type.typeName, type.getSourceFile());

        if (
            !ref ||
            (!ts.isTypeAliasDeclaration(ref.node) && !ts.isInterfaceDeclaration(ref.node))
        ) {
            return;
        }

        if (ts.isTypeAliasDeclaration(ref.node) && !memberShape(ref.node.type, name, context)) {
            return;
        }

        const local = new Map([
            ...env,
            ...resolver.arguments(
                ref.node.typeParameters,
                type.typeArguments,
                type.getSourceFile(),
                env,
                ref.node,
                true,
            ),
        ]);

        if (ts.isTypeAliasDeclaration(ref.node)) {
            return memberType(ref.node.type, name, local, context, resolver, seen);
        }

        const member = ref.node.members.find(
            (member) => member.name?.getText(ref.source).replace(/^['"]|['"]$/g, '') === name,
        );
        return member && ts.isPropertySignature(member) && member.type
            ? { type: member.type, env: local }
            : undefined;
    }

    return;
}

export function resolveSignature(
    type: ts.TypeNode,
    env: TypeEnvironment,
    context: SourceContext,
    resolver: SchemaResolver,
    seen = new Set<ts.Node>(),
): Signature | undefined {
    if (seen.has(type)) {
        return;
    }

    seen.add(type);

    if (ts.isParenthesizedTypeNode(type)) {
        return resolveSignature(type.type, env, context, resolver, seen);
    }

    if (ts.isFunctionTypeNode(type)) {
        return { node: type, env };
    }

    if (ts.isTypeLiteralNode(type)) {
        const signatures = type.members.filter(ts.isCallSignatureDeclaration);

        if (signatures.length === 1) {
            return { node: signatures[0], env };
        }
    }

    if (ts.isTypeReferenceNode(type)) {
        const ref = context.typeName(type.typeName, type.getSourceFile());

        if (!ref) {
            return;
        }

        const node = ref.node;

        if (!ts.isTypeAliasDeclaration(node) && !ts.isInterfaceDeclaration(node)) {
            return;
        }

        if (!callableShape(type, context)) {
            return;
        }

        const local = new Map([
            ...env,
            ...resolver.arguments(
                node.typeParameters,
                type.typeArguments,
                type.getSourceFile(),
                env,
                node,
                true,
            ),
        ]);
        return ts.isTypeAliasDeclaration(node)
            ? resolveSignature(node.type, local, context, resolver, seen)
            : { node: node.members.find(ts.isCallSignatureDeclaration)!, env: local };
    }

    return;
}

export function callableShape(
    type: ts.TypeNode,
    context: SourceContext,
    seen = new Set<ts.Node>(),
): boolean {
    if (seen.has(type)) {
        return false;
    }

    seen.add(type);

    if (ts.isFunctionTypeNode(type)) {
        return true;
    }

    if (ts.isParenthesizedTypeNode(type)) {
        return callableShape(type.type, context, seen);
    }

    if (ts.isTypeLiteralNode(type)) {
        return type.members.filter(ts.isCallSignatureDeclaration).length === 1;
    }

    if (!ts.isTypeReferenceNode(type)) {
        return false;
    }

    const node = context.typeName(type.typeName, type.getSourceFile())?.node;
    return (
        !!node &&
        (ts.isTypeAliasDeclaration(node)
            ? callableShape(node.type, context, seen)
            : ts.isInterfaceDeclaration(node) &&
              node.members.filter(ts.isCallSignatureDeclaration).length === 1)
    );
}

function memberShape(
    type: ts.TypeNode,
    name: string,
    context: SourceContext,
    seen = new Set<ts.Node>(),
): boolean {
    if (seen.has(type)) {
        return false;
    }

    seen.add(type);

    if (ts.isTypeLiteralNode(type)) {
        return type.members.some(
            (member) => member.name?.getText().replace(/^['"]|['"]$/g, '') === name,
        );
    }

    if (!ts.isTypeReferenceNode(type)) {
        return false;
    }

    const node = context.typeName(type.typeName, type.getSourceFile())?.node;
    return (
        !!node &&
        (ts.isTypeAliasDeclaration(node)
            ? memberShape(node.type, name, context, seen)
            : ts.isInterfaceDeclaration(node) &&
              node.members.some(
                  (member) => member.name?.getText().replace(/^['"]|['"]$/g, '') === name,
              ))
    );
}
