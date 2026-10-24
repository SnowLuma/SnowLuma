import ts from 'typescript';
import { packageName } from '../package.js';
import { SourceContext, runtimeImportName, type DeclarationRef } from '../source/context.js';
import { SchemaResolver } from '../schema/resolver.js';
import type { TypeEnvironment, TypeValue } from '../schema/types.js';
import { access, callable, type Plan, type Target, type Requirement, type Site } from './model.js';
import { Receivers } from './receivers.js';
import { callableShape, memberType, resolveSignature, type Signature } from './signatures.js';

interface Plans {
    environment(node: ts.Node): TypeEnvironment;
    plan(node: Target['node']): Plan;
    runtimePlan(fn: Requirement['fn']): Plan;
    bindings(site: Site, partial?: boolean): Map<string, TypeValue>;
}

export class CallTargets {
    private readonly receivers = new Receivers(this);
    constructor(
        readonly context: SourceContext,
        readonly resolver: SchemaResolver,
        readonly graph: Plans,
    ) {}

    signature(type: ts.TypeNode, env: TypeEnvironment) {
        return resolveSignature(type, env, this.context, this.resolver);
    }

    signatureTarget(signature: Signature): Target {
        const plan = this.graph.plan(signature.node);
        return {
            node: signature.node,
            bindings: new Map(
                [...signature.env].flatMap(([name, type]) => {
                    if (signature.node.typeParameters?.some((param) => param.name.text === name)) {
                        return [];
                    }

                    const parameter = plan.env.get(name);
                    return parameter ? [[parameter.key, type] as const] : [];
                }),
            ),
        };
    }

    target(
        expression: ts.Expression,
        source: ts.SourceFile,
        env: TypeEnvironment,
        seen = new Set<ts.Node>(),
    ): Target | undefined {
        if (seen.has(expression)) {
            return;
        }

        seen.add(expression);

        if (callable(expression)) {
            return { node: expression, bindings: new Map() };
        }

        if (ts.isCallExpression(expression)) {
            const factory = this.target(expression.expression, source, env, seen);

            if (
                factory &&
                callable(factory.node) &&
                factory.node.type &&
                callableShape(factory.node.type, this.context)
            ) {
                const local = this.environment(this.specialize(expression, factory, env));
                const signature = this.signature(factory.node.type, local);

                if (signature) {
                    return this.signatureTarget(signature);
                }
            }

            return;
        }

        if (
            ts.isParenthesizedExpression(expression) ||
            ts.isAsExpression(expression) ||
            ts.isNonNullExpression(expression)
        ) {
            return this.target(expression.expression, source, env, seen);
        }

        if (expression.kind === ts.SyntaxKind.SuperKeyword) {
            for (let parent: ts.Node | undefined = expression; parent; parent = parent.parent) {
                if (ts.isClassDeclaration(parent)) {
                    const base = this.graph.plan(parent).base;
                    return base
                        ? { node: base.plan.node, bindings: new Map(base.bindings) }
                        : undefined;
                }
            }
        }

        let ref: DeclarationRef | undefined;
        const property = access(expression);

        if (ts.isIdentifier(expression)) {
            ref = this.context.lookup(expression.text, expression, source);
        } else if (property) {
            let receiver: ts.Expression = property.receiver;

            while (ts.isParenthesizedExpression(receiver)) {
                receiver = receiver.expression;
            }

            const declaration = ts.isIdentifier(receiver)
                ? this.context.lookup(receiver.text, receiver, source)?.node
                : undefined;

            if (
                declaration &&
                (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
                declaration.type
            ) {
                const member = memberType(
                    declaration.type,
                    property.name,
                    env,
                    this.context,
                    this.resolver,
                );
                const signature = member && this.signature(member.type, member.env);

                if (signature) {
                    return this.signatureTarget(signature);
                }
            }

            if (declaration && ts.isNamespaceImport(declaration)) {
                const specifier = (declaration.parent.parent.moduleSpecifier as ts.StringLiteral)
                    .text;

                if (
                    specifier === packageName &&
                    (property.name === 'protobuf_encode' || property.name === 'protobuf_decode')
                ) {
                    return {
                        node: this.graph.runtimePlan(property.name).node,
                        bindings: new Map(),
                    };
                }

                const module = this.context.module(specifier, declaration.getSourceFile());
                ref = module ? this.context.exported(property.name, module) : undefined;
            } else {
                const value = this.receivers.resolve(receiver, source, env, seen);
                const member = value && this.receivers.member(value, property.name);

                if (member) {
                    if (callable(member.node)) {
                        return { node: member.node, bindings: member.bindings };
                    }

                    if ('initializer' in member.node && member.node.initializer) {
                        const target = this.target(
                            member.node.initializer,
                            member.node.getSourceFile(),
                            member.env,
                            seen,
                        );

                        if (target) {
                            return {
                                node: target.node,
                                bindings: new Map([...member.bindings, ...target.bindings]),
                            };
                        }
                    }

                    if (ts.isShorthandPropertyAssignment(member.node)) {
                        return this.target(
                            member.node.name,
                            member.node.getSourceFile(),
                            member.env,
                            seen,
                        );
                    }
                }
            }
        }

        if (!ref) {
            return;
        }

        // Ambient library declarations have no body in which to thread codecs.
        // Their unrelated generic arguments must not enter schema inference.
        if (ref.source.isDeclarationFile) {
            return;
        }

        const runtime = runtimeImportName(ref.node);

        if (runtime === 'protobuf_encode' || runtime === 'protobuf_decode') {
            return { node: this.graph.runtimePlan(runtime).node, bindings: new Map() };
        }

        if ((ts.isParameter(ref.node) || ts.isVariableDeclaration(ref.node)) && ref.node.type) {
            const signature = this.signature(ref.node.type, env);

            if (signature) {
                return this.signatureTarget(signature);
            }
        }

        if (
            ts.isBindingElement(ref.node) &&
            ts.isObjectBindingPattern(ref.node.parent) &&
            (ts.isVariableDeclaration(ref.node.parent.parent) ||
                ts.isParameter(ref.node.parent.parent))
        ) {
            const declaration = ref.node.parent.parent;
            const initializer = declaration.initializer;
            const name = ref.node.propertyName ?? ref.node.name;

            if (declaration.type && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
                const property = memberType(
                    declaration.type,
                    name.text,
                    env,
                    this.context,
                    this.resolver,
                );
                const signature = property && this.signature(property.type, property.env);

                if (signature) {
                    return this.signatureTarget(signature);
                }
            }

            if (initializer && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
                return this.target(
                    ts.factory.createPropertyAccessExpression(initializer, name.text),
                    ref.source,
                    env,
                    seen,
                );
            }
        }

        if (callable(ref.node) || ts.isClassDeclaration(ref.node)) {
            return { node: ref.node, bindings: new Map() };
        }

        if (ts.isVariableDeclaration(ref.node) && ref.node.initializer) {
            if (callable(ref.node.initializer)) {
                return { node: ref.node.initializer, bindings: new Map() };
            }

            return this.target(ref.node.initializer, ref.source, env, seen);
        }

        return;
    }

    specialize(
        node: ts.CallExpression | ts.NewExpression,
        target: Target,
        env: TypeEnvironment,
    ): Target {
        return {
            node: target.node,
            bindings: this.graph.bindings(
                {
                    node,
                    target: this.graph.plan(target.node),
                    bindings: this.capture(node, target, env).bindings,
                    typeArgs: node.typeArguments,
                    env,
                },
                true,
            ),
        };
    }

    capture(node: ts.Node, target: Target, env: TypeEnvironment): Target {
        const bindings = new Map(target.bindings);
        const lexical = this.graph.environment(node);

        for (const [name, type] of this.graph.plan(target.node).env) {
            if (
                !bindings.has(type.key) &&
                !target.node.typeParameters?.some((param) => param.name.text === name) &&
                lexical.get(name)?.key === type.key &&
                env.has(name)
            ) {
                bindings.set(type.key, env.get(name)!);
            }
        }

        return { node: target.node, bindings };
    }

    environment(target: Target): TypeEnvironment {
        return new Map(
            [...this.graph.plan(target.node).env].map(([name, type]) => [
                name,
                this.resolver.substitute(type, target.bindings),
            ]),
        );
    }

    infer(
        expression: ts.Expression,
        source: ts.SourceFile,
        seen = new Set<ts.Node>(),
    ): ts.TypeNode | undefined {
        if (seen.has(expression)) {
            return;
        }

        seen.add(expression);

        if (
            ts.isAsExpression(expression) ||
            ts.isTypeAssertionExpression(expression) ||
            ts.isSatisfiesExpression(expression)
        ) {
            return expression.type;
        }

        if (ts.isIdentifier(expression)) {
            const ref = this.context.lookup(expression.text, expression, source);

            if (ref && (ts.isVariableDeclaration(ref.node) || ts.isParameter(ref.node))) {
                if (ref.node.type) {
                    return ref.node.type;
                }

                if (ref.node.initializer) {
                    return this.infer(ref.node.initializer, ref.source, seen);
                }
            }
        }

        return;
    }
}
