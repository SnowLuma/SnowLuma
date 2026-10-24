import ts from 'typescript';
import { fail } from '../source/context.js';
import type { TypeEnvironment, TypeValue } from '../schema/types.js';
import type { CallAnalysis } from './analysis.js';
import { callable, type Plan, type Requirement, type Edit } from './model.js';
import { codecIndex, unique } from './edits.js';
import { CallbackTypes } from './callback-types.js';

interface Adapter {
    node: ts.Expression;
    target: Plan;
    bindings: Map<string, TypeValue>;
    owner?: Plan;
    signature?: Plan;
}

export class Callbacks {
    readonly adapters = new Map<ts.Expression, Adapter>();
    private readonly candidates: ts.Expression[] = [];
    private cursor = 0;
    private readonly types: CallbackTypes;

    constructor(private readonly graph: CallAnalysis) {
        this.types = new CallbackTypes(graph);
    }

    record(node: ts.Node): void {
        switch (node.kind) {
            case ts.SyntaxKind.ExpressionWithTypeArguments:
                if (!ts.isHeritageClause(node.parent)) {
                    this.candidates.push(node as ts.ExpressionWithTypeArguments);
                }

                break;
            case ts.SyntaxKind.VariableDeclaration:
            case ts.SyntaxKind.Parameter:
            case ts.SyntaxKind.PropertyDeclaration:
            case ts.SyntaxKind.PropertyAssignment:
                this.candidate((node as ts.VariableDeclaration).initializer);
                break;
            case ts.SyntaxKind.CallExpression:
                for (const argument of (node as ts.CallExpression).arguments) {
                    this.candidate(argument);
                }

                break;
            case ts.SyntaxKind.ArrayLiteralExpression:
                for (const element of (node as ts.ArrayLiteralExpression).elements) {
                    this.candidate(element);
                }

                break;
            case ts.SyntaxKind.ShorthandPropertyAssignment:
                this.candidate((node as ts.ShorthandPropertyAssignment).name);
                break;
            case ts.SyntaxKind.ReturnStatement:
            case ts.SyntaxKind.ParenthesizedExpression:
            case ts.SyntaxKind.AsExpression:
            case ts.SyntaxKind.SatisfiesExpression:
                this.candidate((node as ts.ReturnStatement).expression);
                break;

            case ts.SyntaxKind.ConditionalExpression: {
                const expression = node as ts.ConditionalExpression;
                this.candidate(expression.whenTrue);
                this.candidate(expression.whenFalse);
                break;
            }

            case ts.SyntaxKind.BinaryExpression: {
                const expression = node as ts.BinaryExpression;

                if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                    this.candidate(expression.right);
                }

                break;
            }

            case ts.SyntaxKind.PropertyAccessExpression: {
                const expression = node as ts.PropertyAccessExpression;

                if (expression.name.text === 'bind') {
                    this.candidate(expression.expression);
                }
            }
        }
    }

    private candidate(node: ts.Expression | undefined): void {
        if (
            node &&
            (ts.isIdentifier(node) ||
                ts.isPropertyAccessExpression(node) ||
                ts.isElementAccessExpression(node) ||
                callable(node))
        ) {
            this.candidates.push(node);
        }
    }

    collect(): void {
        while (this.cursor < this.candidates.length) {
            this.add(this.candidates[this.cursor++]);
        }
    }

    private add(node: ts.Expression): void {
        const graph = this.graph;
        const env = graph.environment(node);
        const explicit = ts.isExpressionWithTypeArguments(node) ? node : undefined;
        const target = graph.targets.target(
            explicit?.expression ?? node,
            node.getSourceFile(),
            env,
        );

        if (!target || ts.isClassDeclaration(target.node)) {
            return;
        }

        const plan = graph.plan(target.node);

        if (!plan.node.typeParameters?.length) {
            return;
        }

        graph.scan(plan.node.getSourceFile());
        const ownerNode = graph.owner(node);
        const adapter: Adapter = {
            node,
            target: plan,
            bindings: new Map(target.bindings),
            owner: ownerNode ? graph.plan(ownerNode) : undefined,
        };

        if (explicit) {
            const args = graph.resolver.arguments(
                plan.node.typeParameters,
                explicit.typeArguments,
                node.getSourceFile(),
                env,
                plan.node,
            );

            for (const [name, type] of args) {
                adapter.bindings.set(plan.env.get(name)!.key, type);
            }
        } else {
            const context = this.types.context(node, env);

            if (!context) {
                return;
            }

            const signature = context.signature;
            const local = new Map(signature?.env ?? env);

            if (signature?.node.typeParameters?.length) {
                adapter.signature = graph.plan(signature.node);

                for (const param of signature.node.typeParameters) {
                    local.set(param.name.text, adapter.signature.env.get(param.name.text)!);
                }
            }

            const parameters = graph.parameters(plan.node) ?? [];
            const actual =
                context.types ?? graph.parameters(signature!.node)!.map((param) => param.type);
            parameters.forEach((param, index) => {
                if (
                    param.type &&
                    actual[index] &&
                    plan.runtime !== 'protobuf_decode' &&
                    mentionsGeneric(param.type, plan.env)
                ) {
                    graph.unify(
                        graph.resolver.type(param.type, param.getSourceFile(), plan.env),
                        graph.resolver.type(actual[index]!, actual[index]!.getSourceFile(), local),
                        adapter.bindings,
                        node,
                    );
                }
            });

            if (plan.runtime === 'protobuf_decode' && signature) {
                adapter.bindings.set(
                    plan.env.get('T')!.key,
                    graph.resolver.type(
                        signature.node.type!,
                        signature.node.getSourceFile(),
                        local,
                    ),
                );
            }

            for (const parameter of plan.node.typeParameters ?? []) {
                const key = plan.env.get(parameter.name.text)!.key;

                if (!adapter.bindings.has(key) && parameter.default) {
                    adapter.bindings.set(
                        key,
                        graph.resolver.type(parameter.default, parameter.getSourceFile(), env),
                    );
                }
            }
        }

        this.adapters.set(node, adapter);
    }

    connections(): { target: Plan; owner?: Plan; bindings: () => Map<string, TypeValue> }[] {
        return [...this.adapters.values()].map((adapter) => ({
            target: adapter.target,
            owner: adapter.signature ?? adapter.owner,
            bindings: () => adapter.bindings,
        }));
    }

    emit(
        source: ts.SourceFile,
        reference: (req: Requirement, owner?: Plan) => string,
        edits: Edit[],
    ): void {
        for (const adapter of this.adapters.values()) {
            if (adapter.node.getSourceFile() !== source || !adapter.target.requirements.size) {
                continue;
            }

            const { target, signature, node } = adapter;

            if (target === signature) {
                continue;
            }

            const requirements = [...target.requirements.values()].map((req) =>
                this.graph.instantiate(req, adapter.bindings),
            );

            for (const req of requirements) {
                if (
                    [...target.env.values()].some(
                        (type) => type.dynamic && req.type.key === type.key,
                    )
                ) {
                    fail(
                        node,
                        'Cannot infer callback schema; annotate its parameter type or supply type arguments.',
                    );
                }
            }

            const codecs = requirements.map((req) => reference(req, signature ?? adapter.owner));

            if (target.runtime && !signature) {
                const text =
                    target.runtime === 'protobuf_decode'
                        ? `(bytes => ${codecs[0]}(bytes))`
                        : codecs[0];
                edits.push({ start: node.getStart(source), end: node.end, text });
                continue;
            }

            const params = this.graph.parameters(target.node) ?? [];
            const count = params.findIndex((param) => !!param.dotDotDotToken);
            const arity = count < 0 ? params.length : count;
            const signatureParams = signature && this.graph.parameters(signature.node)!;
            const signatureRest =
                signatureParams?.findIndex((param) => !!param.dotDotDotToken) ?? -1;
            const incomingArity = signatureParams
                ? signatureRest < 0
                    ? signatureParams.length
                    : signatureRest
                : arity;
            const prefix = unique(source, '__pb_callback');
            const args = Array.from(
                { length: Math.max(arity, incomingArity) },
                (_, index) => `${prefix}_${index}`,
            );
            const hidden = signature
                ? [...signature.requirements.keys()].map((key) =>
                      this.graph.parameterName(signature, key),
                  )
                : [];
            const incoming = args.map((name, index) =>
                params[index]?.initializer ? `${name} = undefined` : name,
            );
            incoming.splice(incomingArity, 0, ...hidden.map((name) => `${name} = undefined`));

            if (count >= 0) {
                incoming.push(`...${prefix}_rest`);
            }

            const index = codecIndex(params);
            const forwarded = [...args.slice(0, index), ...codecs, ...args.slice(index, arity)];

            if (count >= 0) {
                forwarded.push(...args.slice(arity), `...${prefix}_rest`);
            }

            const call = target.runtime
                ? `${codecs[0]}(${args[0]})`
                : `${prefix}_fn.call(this, ${forwarded.join(', ')})`;
            const property = ts.isShorthandPropertyAssignment(node.parent)
                ? node.getText(source) + ': '
                : '';
            edits.push({
                start: node.getStart(source),
                end: node.getStart(source),
                text: `${property}((${prefix}_fn) => function(${incoming.join(', ')}) { return ${call}; })(`,
            });
            edits.push({ start: node.end, end: node.end, text: ')', order: -1 });
        }
    }
}

export function mentionsGeneric(node: ts.Node, env: TypeEnvironment): boolean {
    if (ts.isIdentifier(node) && env.get(node.text)?.dynamic) {
        return true;
    }

    return ts.forEachChild(node, (child) => mentionsGeneric(child, env)) ?? false;
}
