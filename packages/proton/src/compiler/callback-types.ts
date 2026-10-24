import ts from 'typescript';
import { fail } from '../source/context.js';
import type { TypeEnvironment } from '../schema/types.js';
import { memberType, type Signature } from './signatures.js';
import { callable } from './model.js';
import type { CallAnalysis } from './analysis.js';

interface Expected {
    type: ts.TypeNode;
    env: TypeEnvironment;
}

export class CallbackTypes {
    constructor(private readonly graph: CallAnalysis) {}

    context(
        node: ts.Expression,
        env: TypeEnvironment,
    ): { signature?: Signature; types?: ts.TypeNode[] } | undefined {
        const expected = this.expected(node, env);
        const signature = expected && this.graph.targets.signature(expected.type, expected.env);

        if (signature) {
            return { signature };
        }

        const parent = node.parent;

        if (
            ts.isCallExpression(parent) &&
            parent.arguments[0] === node &&
            ts.isPropertyAccessExpression(parent.expression) &&
            ['map', 'forEach', 'flatMap', 'filter', 'find', 'some', 'every'].includes(
                parent.expression.name.text,
            )
        ) {
            const array = this.graph.targets.infer(
                parent.expression.expression,
                node.getSourceFile(),
            );
            const element = array && this.element(array);

            if (element) {
                return { types: [element] };
            }
        }

        return;
    }

    private expected(node: ts.Node, env: TypeEnvironment): Expected | undefined {
        const graph = this.graph;
        let child = node;

        if (
            ts.isPropertyAccessExpression(child.parent) &&
            child.parent.name.text === 'bind' &&
            ts.isCallExpression(child.parent.parent)
        ) {
            child = child.parent.parent;
        }

        while (
            ts.isParenthesizedExpression(child.parent) ||
            ts.isConditionalExpression(child.parent)
        ) {
            child = child.parent;
        }

        const parent = child.parent;

        if (
            (ts.isVariableDeclaration(parent) ||
                ts.isParameter(parent) ||
                ts.isPropertyDeclaration(parent) ||
                ts.isAsExpression(parent) ||
                ts.isSatisfiesExpression(parent)) &&
            parent.type
        ) {
            return { type: parent.type, env };
        }

        if (
            ts.isBinaryExpression(parent) &&
            parent.right === child &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
            const type = graph.targets.infer(parent.left, node.getSourceFile());

            if (type) {
                return { type, env };
            }
        }

        if (
            (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) &&
            ts.isObjectLiteralExpression(parent.parent)
        ) {
            const object = this.expected(parent.parent, env);
            return (
                object &&
                memberType(
                    object.type,
                    parent.name.getText().replace(/^['"]|['"]$/g, ''),
                    object.env,
                    graph.context,
                    graph.resolver,
                )
            );
        }

        if (ts.isArrayLiteralExpression(parent)) {
            const array = this.expected(parent, env);
            const type = array && this.element(array.type);
            return type && array ? { type, env: array.env } : undefined;
        }

        if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === child)) {
            for (let fn: ts.Node | undefined = parent; fn; fn = fn.parent) {
                if (callable(fn)) {
                    return fn.type ? { type: fn.type, env } : undefined;
                }
            }
        }

        if (ts.isCallExpression(parent)) {
            const index = parent.arguments.indexOf(child as ts.Expression);
            const site = graph.sites
                .get(node.getSourceFile())
                ?.find((site) => site.node === parent);
            const parameter = site?.target && graph.parameters(site.target.node)?.[index];

            if (site?.target && parameter?.type) {
                const bindings = graph.bindings(site, true);
                const local = new Map(
                    [...site.target.env].map(([name, value]) => [
                        name,
                        graph.resolver.substitute(value, bindings),
                    ]),
                );
                const signature = graph.targets.signature(parameter.type, local);

                if (
                    signature?.node.typeParameters?.length &&
                    (site.target.node.getSourceFile().isDeclarationFile ||
                        (ts.isFunctionDeclaration(site.target.node) && !site.target.node.body))
                ) {
                    fail(
                        node,
                        'Polymorphic callbacks require the receiving implementation to participate in the build.',
                    );
                }

                return { type: parameter.type, env: local };
            }
        }

        return;
    }

    private element(type: ts.TypeNode): ts.TypeNode | undefined {
        return ts.isArrayTypeNode(type)
            ? type.elementType
            : ts.isTypeReferenceNode(type) &&
                ['Array', 'ReadonlyArray'].includes(type.typeName.getText())
              ? type.typeArguments?.[0]
              : undefined;
    }
}
