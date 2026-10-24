import ts from 'typescript';
import type { TypeEnvironment, TypeValue } from '../schema/types.js';

export type Callable =
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration
    | ts.FunctionTypeNode
    | ts.CallSignatureDeclaration;
export type Owner = Callable | ts.ClassDeclaration;
export interface Requirement {
    key: string;
    fn: 'protobuf_encode' | 'protobuf_decode';
    type: TypeValue;
    node: ts.Node;
}
export interface Plan {
    runtime?: Requirement['fn'];
    node: Owner;
    env: TypeEnvironment;
    requirements: Map<string, Requirement>;
    names: Map<string, string>;
    base?: { plan: Plan; bindings: Map<string, TypeValue> };
}
export interface Target {
    node: Owner;
    bindings: Map<string, TypeValue>;
}
export interface Site {
    node: ts.CallExpression | ts.NewExpression;
    owner?: Plan;
    direct?: Requirement;
    target?: Plan;
    bindings?: Map<string, TypeValue>;
    typeArgs?: readonly ts.TypeNode[];
    env?: TypeEnvironment;
    bound?: boolean;
}
export interface Edit {
    order?: number;
    start: number;
    end: number;
    text: string;
}

export function callable(node: ts.Node): node is Callable {
    switch (node.kind) {
        case ts.SyntaxKind.FunctionDeclaration:
        case ts.SyntaxKind.FunctionExpression:
        case ts.SyntaxKind.ArrowFunction:
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.FunctionType:
        case ts.SyntaxKind.CallSignature:
            return true;
        default:
            return false;
    }
}

export function constructorOf(node: ts.ClassDeclaration): ts.ConstructorDeclaration | undefined {
    return node.members.find(
        (member): member is ts.ConstructorDeclaration =>
            ts.isConstructorDeclaration(member) && !!member.body,
    );
}

export function memberName(name: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }

    if (
        ts.isComputedPropertyName(name) &&
        (ts.isStringLiteralLike(name.expression) || ts.isNumericLiteral(name.expression))
    ) {
        return name.expression.text;
    }

    return;
}

export function access(
    expression: ts.Expression,
): { receiver: ts.Expression; name: string } | undefined {
    if (ts.isPropertyAccessExpression(expression)) {
        return { receiver: expression.expression, name: expression.name.text };
    }

    if (
        ts.isElementAccessExpression(expression) &&
        (ts.isStringLiteralLike(expression.argumentExpression) ||
            ts.isNumericLiteral(expression.argumentExpression))
    ) {
        return { receiver: expression.expression, name: expression.argumentExpression.text };
    }

    return;
}
