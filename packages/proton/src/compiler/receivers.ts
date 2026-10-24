import ts from 'typescript';
import { fail } from '../source/context.js';
import type { TypeEnvironment } from '../schema/types.js';
import {
    access,
    callable,
    constructorOf,
    memberName,
    type Callable,
    type Target,
} from './model.js';
import type { CallTargets } from './targets.js';

interface Receiver {
    node: ts.ClassDeclaration | ts.ObjectLiteralExpression;
    bindings: Target['bindings'];
    env: TypeEnvironment;
}
type Returning = Callable | ts.GetAccessorDeclaration;

export class Receivers {
    private readonly returns = new WeakMap<Returning, ts.Expression[]>();

    constructor(private readonly targets: CallTargets) {}

    resolve(
        expression: ts.Expression,
        source: ts.SourceFile,
        env: TypeEnvironment,
        seen = new Set<ts.Node>(),
    ): Receiver | undefined {
        if (seen.has(expression)) {
            return;
        }

        seen.add(expression);
        const { context } = this.targets;

        if (
            ts.isParenthesizedExpression(expression) ||
            ts.isNonNullExpression(expression) ||
            ts.isSatisfiesExpression(expression)
        ) {
            return this.resolve(expression.expression, source, env, seen);
        }

        if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
            return (
                this.annotation(expression.type, env, seen) ??
                this.resolve(expression.expression, source, env, seen)
            );
        }

        if (ts.isObjectLiteralExpression(expression)) {
            return { node: expression, env, bindings: new Map() };
        }

        if (expression.kind === ts.SyntaxKind.ThisKeyword) {
            for (let parent = expression.parent; parent; parent = parent.parent) {
                if (ts.isClassDeclaration(parent)) {
                    const target = this.targets.capture(
                        expression,
                        { node: parent, bindings: new Map() },
                        env,
                    );
                    return {
                        node: parent,
                        bindings: target.bindings,
                        env: this.targets.environment(target),
                    };
                }
            }
        }

        if (ts.isIdentifier(expression)) {
            const declaration = context.lookup(expression.text, expression, source)?.node;

            if (declaration && ts.isClassDeclaration(declaration)) {
                return {
                    node: declaration,
                    bindings: new Map(),
                    env: this.targets.graph.plan(declaration).env,
                };
            }

            if (
                declaration &&
                (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))
            ) {
                const annotated = declaration.type && this.annotation(declaration.type, env, seen);

                if (annotated) {
                    return annotated;
                }

                if (declaration.initializer) {
                    return this.resolve(
                        declaration.initializer,
                        declaration.getSourceFile(),
                        env,
                        seen,
                    );
                }
            }
        }

        const property = access(expression);

        if (property) {
            const receiver = this.resolve(property.receiver, source, env, seen);
            const member = receiver && this.member(receiver, property.name);

            if (!member) {
                return;
            }

            const node = member.node;

            if ('type' in node && node.type) {
                const annotated = this.annotation(node.type, member.env, seen);

                if (annotated) {
                    return annotated;
                }
            }

            if (ts.isGetAccessorDeclaration(node)) {
                return this.returned(node, member.env, seen, expression);
            }

            if ('initializer' in node && node.initializer) {
                return this.resolve(node.initializer, node.getSourceFile(), member.env, seen);
            }

            if (ts.isShorthandPropertyAssignment(node)) {
                return this.resolve(node.name, node.getSourceFile(), member.env, seen);
            }
        }

        if (ts.isNewExpression(expression) || ts.isCallExpression(expression)) {
            const target = this.targets.target(expression.expression, source, env, seen);

            if (!target) {
                return;
            }

            const specialized = this.targets.specialize(expression, target, env);
            const local = this.targets.environment(specialized);

            if (ts.isNewExpression(expression)) {
                return ts.isClassDeclaration(target.node)
                    ? { node: target.node, bindings: specialized.bindings, env: local }
                    : undefined;
            }

            if (!callable(target.node)) {
                return;
            }

            const annotated = target.node.type && this.annotation(target.node.type, local, seen);
            return annotated || this.returned(target.node, local, seen, expression);
        }

        if (ts.isConditionalExpression(expression)) {
            return this.merge([expression.whenTrue, expression.whenFalse], env, seen, expression);
        }

        return;
    }

    member(
        receiver: Receiver,
        name: string,
    ):
        | {
              node: ts.ClassElement | ts.ObjectLiteralElementLike | ts.ParameterDeclaration;
              bindings: Target['bindings'];
              env: TypeEnvironment;
          }
        | undefined {
        const { graph, resolver } = this.targets;
        let node = receiver.node;
        const bindings = new Map(receiver.bindings);

        for (;;) {
            const members = ts.isClassDeclaration(node) ? node.members : node.properties;
            const member =
                members.find(
                    (member) =>
                        member.name &&
                        memberName(member.name) === name &&
                        (!ts.isMethodDeclaration(member) || !!member.body),
                ) ??
                (ts.isClassDeclaration(node)
                    ? constructorOf(node)?.parameters.find(
                          (param) =>
                              ts.isIdentifier(param.name) &&
                              param.name.text === name &&
                              param.modifiers?.length,
                      )
                    : undefined);

            if (member) {
                const env = ts.isClassDeclaration(node)
                    ? this.targets.environment({ node, bindings })
                    : receiver.env;
                return { node: member, bindings, env };
            }

            const base = ts.isClassDeclaration(node) && graph.plan(node).base;

            if (!base || !ts.isClassDeclaration(base.plan.node)) {
                return;
            }

            for (const [key, type] of base.bindings) {
                bindings.set(key, resolver.substitute(type, bindings));
            }

            node = base.plan.node;
        }
    }

    private annotation(
        type: ts.TypeNode,
        env: TypeEnvironment,
        seen: Set<ts.Node>,
    ): Receiver | undefined {
        if (seen.has(type)) {
            return;
        }

        seen.add(type);

        if (ts.isParenthesizedTypeNode(type)) {
            return this.annotation(type.type, env, seen);
        }

        if (ts.isUnionTypeNode(type)) {
            const types = type.types.filter(
                (item) =>
                    item.kind !== ts.SyntaxKind.UndefinedKeyword &&
                    !(
                        ts.isLiteralTypeNode(item) &&
                        item.literal.kind === ts.SyntaxKind.NullKeyword
                    ),
            );

            if (types.length === 1) {
                return this.annotation(types[0], env, seen);
            }

            return;
        }

        if (!ts.isTypeReferenceNode(type)) {
            return;
        }

        const { context, resolver, graph } = this.targets;
        const ref = context.typeName(type.typeName, type.getSourceFile());

        if (!ref || (!ts.isClassDeclaration(ref.node) && !ts.isTypeAliasDeclaration(ref.node))) {
            return;
        }

        if (ts.isTypeAliasDeclaration(ref.node) && !this.classShape(ref.node.type)) {
            return;
        }

        const args = resolver.arguments(
            ref.node.typeParameters,
            type.typeArguments,
            type.getSourceFile(),
            env,
            ref.node,
        );

        if (ts.isTypeAliasDeclaration(ref.node)) {
            return this.annotation(ref.node.type, new Map([...env, ...args]), seen);
        }

        const plan = graph.plan(ref.node);
        const target = this.targets.capture(
            type,
            {
                node: ref.node,
                bindings: new Map([...args].map(([name, type]) => [plan.env.get(name)!.key, type])),
            },
            env,
        );
        return { node: ref.node, bindings: target.bindings, env: this.targets.environment(target) };
    }

    private classShape(type: ts.TypeNode, seen = new Set<ts.Node>()): boolean {
        if (seen.has(type)) {
            return false;
        }

        seen.add(type);

        if (ts.isParenthesizedTypeNode(type)) {
            return this.classShape(type.type, seen);
        }

        if (ts.isUnionTypeNode(type)) {
            return type.types.some((member) => this.classShape(member, seen));
        }

        if (!ts.isTypeReferenceNode(type)) {
            return false;
        }

        const node = this.targets.context.typeName(type.typeName, type.getSourceFile())?.node;
        return (
            !!node &&
            (ts.isClassDeclaration(node) ||
                (ts.isTypeAliasDeclaration(node) && this.classShape(node.type, seen)))
        );
    }

    private returned(
        node: Returning,
        env: TypeEnvironment,
        seen: Set<ts.Node>,
        origin: ts.Node,
    ): Receiver | undefined {
        const cached = this.returns.get(node);

        if (cached) {
            return this.merge(cached, env, seen, origin);
        }

        const expressions: ts.Expression[] = [];

        if ('body' in node && node.body) {
            if (ts.isBlock(node.body)) {
                const visit = (child: ts.Node): void => {
                    if (ts.isFunctionLike(child) || ts.isClassDeclaration(child)) {
                        return;
                    }

                    if (ts.isReturnStatement(child)) {
                        if (child.expression) {
                            expressions.push(child.expression);
                        }
                    } else {
                        ts.forEachChild(child, visit);
                    }
                };

                visit(node.body);
            } else {
                expressions.push(node.body);
            }
        }

        this.returns.set(node, expressions);
        return this.merge(expressions, env, seen, origin);
    }

    private merge(
        expressions: ts.Expression[],
        env: TypeEnvironment,
        seen: Set<ts.Node>,
        origin: ts.Node,
    ): Receiver | undefined {
        let result: Receiver | undefined;

        for (const expression of expressions) {
            const next = this.resolve(expression, expression.getSourceFile(), env, new Set(seen));

            if (!next) {
                return;
            }

            if (
                result &&
                (result.node !== next.node ||
                    [...result.env].some(([name, type]) => next.env.get(name)?.key !== type.key))
            ) {
                // Data objects returned by ordinary functions need no codec
                // specialization, even when their branches have different shapes.
                if (
                    ts.isObjectLiteralExpression(result.node) &&
                    ts.isObjectLiteralExpression(next.node) &&
                    ![...result.node.properties, ...next.node.properties].some(
                        (member) =>
                            callable(member) ||
                            (ts.isPropertyAssignment(member) && callable(member.initializer)),
                    )
                ) {
                    return;
                }

                fail(origin, 'Receiver branches must resolve to the same specialization.');
            }

            result = next;
        }

        return result;
    }
}
