import ts from 'typescript';
import { fail } from '../source/context.js';
import { callable } from './model.js';
import type { CallAnalysis } from './analysis.js';

export function validateSource(graph: CallAnalysis, source: ts.SourceFile): void {
    if (![...graph.plans.values()].some((plan) => plan.requirements.size)) {
        return;
    }

    const visit = (node: ts.Node): void => {
        if (ts.isExpressionWithTypeArguments(node) && !ts.isHeritageClause(node.parent)) {
            const target = graph.targets.target(node.expression, source, graph.environment(node));

            if (
                target &&
                graph.plan(target.node).requirements.size &&
                !graph.callbacks.adapters.has(node)
            ) {
                fail(node, 'Generic function values require an explicitly typed arrow adapter.');
            }
        }

        if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            return;
        }

        if (ts.isIdentifier(node) && node.text === 'arguments') {
            const owner = graph.owner(node);

            if (owner && graph.plan(owner).requirements.size) {
                fail(
                    node,
                    'Generic codec functions cannot reflect on arguments; use named or rest parameters.',
                );
            }
        }

        if (
            (ts.isIdentifier(node) ||
                ts.isPropertyAccessExpression(node) ||
                ts.isElementAccessExpression(node) ||
                ts.isArrowFunction(node) ||
                ts.isFunctionExpression(node)) &&
            isValuePosition(node)
        ) {
            const target = graph.targets.target(node, source, graph.environment(node));
            const owner = target && graph.owner(target.node);

            if (
                target &&
                !graph.callbacks.adapters.has(node) &&
                !ts.isClassDeclaration(target.node) &&
                (graph.plan(target.node).requirements.size ||
                    (ts.isMethodDeclaration(target.node) &&
                        owner &&
                        graph.plan(owner).requirements.size))
            ) {
                fail(
                    node,
                    'Cannot infer callback schema; annotate the callback type or supply concrete type arguments.',
                );
            }
        }

        if (
            (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
            ts.isVariableDeclaration(node.parent) &&
            node.parent.initializer === node
        ) {
            const target = graph.targets.target(node, source, graph.environment(node));
            const owner = target && graph.owner(target.node);

            if (
                target &&
                ts.isMethodDeclaration(target.node) &&
                !target.node.typeParameters?.length &&
                owner &&
                ts.isClassDeclaration(owner) &&
                graph.plan(owner).requirements.size
            ) {
                fail(
                    node,
                    'Instance codec methods require their receiver; use an arrow adapter instead of detaching the method.',
                );
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(source);

    for (const site of graph.sites.get(source) ?? []) {
        if (!site.direct?.type.dynamic || !site.owner || !ts.isClassDeclaration(site.owner.node)) {
            continue;
        }

        for (
            let parent = site.node.parent;
            parent && parent !== site.owner.node;
            parent = parent.parent
        ) {
            if (callable(parent) || ts.isConstructorDeclaration(parent)) {
                break;
            }

            if (ts.isPropertyDeclaration(parent)) {
                fail(
                    site.node,
                    'Move generic codec calls from class field initializers into the constructor body.',
                );
            }
        }
    }
}

function isValuePosition(node: ts.Expression): boolean {
    let value: ts.Node = node;

    while (
        ts.isParenthesizedExpression(value.parent) ||
        ts.isAsExpression(value.parent) ||
        ts.isSatisfiesExpression(value.parent)
    ) {
        value = value.parent;
    }

    const parent = value.parent;
    return (
        (ts.isCallExpression(parent) && parent.expression !== value) ||
        ts.isReturnStatement(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isArrayLiteralExpression(parent) ||
        (ts.isPropertyAssignment(parent) && parent.initializer === value) ||
        (ts.isBinaryExpression(parent) &&
            parent.right === value &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    );
}
