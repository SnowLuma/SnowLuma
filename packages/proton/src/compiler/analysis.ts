import { unique } from './edits.js';
import { Callbacks, mentionsGeneric } from './callbacks.js';
import ts from 'typescript';
import { packageName } from '../package.js';
import { SourceContext, fail, runtimeImportName } from '../source/context.js';
import { SchemaResolver } from '../schema/resolver.js';
import type { TypeEnvironment, TypeValue } from '../schema/types.js';
import {
    callable,
    constructorOf,
    type Owner,
    type Plan,
    type Requirement,
    type Site,
} from './model.js';
import { CallTargets } from './targets.js';

export class CallAnalysis {
    readonly plans = new Map<Owner, Plan>();
    readonly sites = new Map<ts.SourceFile, Site[]>();
    readonly targets: CallTargets;
    readonly callbacks = new Callbacks(this);
    private readonly runtimePlans = new Map<string, Plan>();

    constructor(
        readonly context: SourceContext,
        readonly resolver: SchemaResolver,
    ) {
        this.targets = new CallTargets(context, resolver, this);
    }

    runtimePlan(fn: Requirement['fn']): Plan {
        let plan = this.runtimePlans.get(fn);

        if (!plan) {
            const source = ts.createSourceFile(
                `${fn}.internal.ts`,
                `function ${fn}<T>(value: T) {}`,
                ts.ScriptTarget.Latest,
                true,
            );
            plan = this.plan(source.statements[0] as ts.FunctionDeclaration);
            plan.runtime = fn;
            const type = plan.env.get('T')!;
            const requirement = { key: `${fn}:${type.key}`, fn, type, node: plan.node };
            plan.requirements.set(requirement.key, requirement);
            this.runtimePlans.set(fn, plan);
        }

        return plan;
    }

    scan(source: ts.SourceFile): void {
        if (this.sites.has(source)) {
            return;
        }

        const sites: Site[] = [];
        this.sites.set(source, sites);

        if (source.isDeclarationFile) {
            return;
        }

        for (const statement of source.statements) {
            if (
                (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
                !statement.moduleSpecifier ||
                !ts.isStringLiteral(statement.moduleSpecifier)
            ) {
                continue;
            }

            const imported = this.context.module(statement.moduleSpecifier.text, source);

            if (
                imported &&
                !imported.isDeclarationFile &&
                !imported.fileName.includes('/node_modules/')
            ) {
                this.scan(imported);
            }
        }

        let env: TypeEnvironment = new Map();
        let owner: Plan | undefined;

        const visit = (node: ts.Node): void => {
            this.callbacks.record(node);

            if (
                ts.isTypeNode(node) ||
                ts.isInterfaceDeclaration(node) ||
                ts.isImportDeclaration(node) ||
                ts.isExportDeclaration(node)
            ) {
                return;
            }

            const outerEnv = env;
            const outerOwner = owner;

            if (ts.isClassDeclaration(node)) {
                this.plan(node);
            }

            if ((callable(node) || ts.isClassDeclaration(node)) && node.typeParameters?.length) {
                owner = this.plan(node);
                env = owner.env;
            }

            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                let fn = ts.isCallExpression(node)
                    ? this.protobufFunction(node.expression, source)
                    : undefined;
                const target = fn ? undefined : this.targets.target(node.expression, source, env);

                if (!fn && ts.isCallExpression(node) && target) {
                    fn = this.plan(target.node).runtime;
                }

                if (fn) {
                    const typeNode =
                        node.typeArguments?.[0] ??
                        (fn === 'protobuf_encode' && node.arguments?.[0]
                            ? this.targets.infer(node.arguments[0], source)
                            : undefined);

                    if (!typeNode) {
                        fail(
                            node,
                            'Cannot infer protobuf schema; supply an explicit type argument.',
                        );
                    }

                    const type = this.resolver.type(typeNode, typeNode.getSourceFile(), env);
                    const direct: Requirement = { key: `${fn}:${type.key}`, fn, type, node };

                    if (type.dynamic && owner) {
                        owner.requirements.set(direct.key, direct);
                    }

                    sites.push({ node, owner, direct });
                } else {
                    if (target) {
                        const plan = this.plan(target.node);
                        sites.push({
                            node,
                            owner,
                            target: plan,
                            bindings: target.bindings,
                            typeArgs: node.typeArguments,
                            env,
                        });
                        this.scan(target.node.getSourceFile());
                    }
                }
            }

            ts.forEachChild(node, visit);
            env = outerEnv;
            owner = outerOwner;
        };

        visit(source);
    }

    propagate(): void {
        const consumers = new Map<
            Plan,
            { owner?: Plan; bindings: () => Map<string, TypeValue> }[]
        >();

        const connect = (
            target: Plan,
            owner: Plan | undefined,
            bindings: () => Map<string, TypeValue>,
        ) => {
            const list = consumers.get(target) ?? [];
            list.push({ owner, bindings });
            consumers.set(target, list);
        };

        for (const sites of this.sites.values()) {
            for (const site of sites) {
                if (site.target) {
                    connect(site.target, site.owner, () => this.bindings(site));
                }
            }
        }

        for (const adapter of this.callbacks.connections()) {
            connect(adapter.target, adapter.owner, adapter.bindings);
        }

        for (const plan of this.plans.values()) {
            if (plan.base) {
                connect(plan.base.plan, plan, () => plan.base!.bindings);
            }
        }

        const queue = [...this.plans.values()].flatMap((plan) =>
            [...plan.requirements.values()].map((requirement) => ({ plan, requirement })),
        );

        for (let index = 0; index < queue.length; index++) {
            const { plan, requirement } = queue[index];

            for (const consumer of consumers.get(plan) ?? []) {
                const instantiated = this.instantiate(requirement, consumer.bindings());
                const owner = consumer.owner;

                if (
                    !instantiated.type.dynamic ||
                    !owner ||
                    owner.requirements.has(instantiated.key)
                ) {
                    continue;
                }

                if (owner.requirements.size >= 128) {
                    fail(owner.node, 'Generic codec expansion does not converge.');
                }

                owner.requirements.set(instantiated.key, instantiated);
                queue.push({ plan: owner, requirement: instantiated });
            }
        }
    }

    instantiate(req: Requirement, bindings: Map<string, TypeValue>): Requirement {
        const type = this.resolver.substitute(req.type, bindings);
        return { ...req, type, key: `${req.fn}:${type.key}` };
    }

    bindings(site: Site, partial = false): Map<string, TypeValue> {
        if (!site.bound) {
            const plan = site.target!;

            // Ordinary calls cannot contribute generic codec bindings. Resolving
            // their parameter types would treat unrelated application data as schemas.
            if (plan.env.size === 0 && !plan.base) {
                site.bound = true;
                return site.bindings!;
            }

            if (!site.typeArgs?.length) {
                this.parameters(plan.node)?.forEach((param, index) => {
                    const argument = site.node.arguments?.[index];
                    const actual =
                        argument && this.targets.infer(argument, site.node.getSourceFile());

                    if (
                        param.type &&
                        actual &&
                        mentionsGeneric(param.type, this.environment(param)) &&
                        !this.targets.signature(param.type, plan.env)
                    ) {
                        // Matching generic containers expose their arguments directly;
                        // unrelated members need not be expanded as protobuf schemas.
                        const pattern = param.type;

                        if (
                            ts.isTypeReferenceNode(pattern) &&
                            ts.isTypeReferenceNode(actual) &&
                            pattern.typeArguments?.length &&
                            pattern.typeArguments.length === actual.typeArguments?.length &&
                            this.context.typeName(pattern.typeName, pattern.getSourceFile())
                                ?.node &&
                            this.context.typeName(pattern.typeName, pattern.getSourceFile())
                                ?.node ===
                                this.context.typeName(actual.typeName, actual.getSourceFile())?.node
                        ) {
                            pattern.typeArguments.forEach((type, i) =>
                                this.unify(
                                    this.resolver.type(
                                        type,
                                        type.getSourceFile(),
                                        this.environment(param),
                                    ),
                                    partial
                                        ? this.resolver.lazy(
                                              actual.typeArguments![i],
                                              actual.getSourceFile(),
                                              site.env!,
                                          )
                                        : this.resolver.type(
                                              actual.typeArguments![i],
                                              actual.getSourceFile(),
                                              site.env,
                                          ),
                                    site.bindings!,
                                    site.node,
                                ),
                            );
                            return;
                        }

                        this.unify(
                            this.resolver.type(
                                param.type,
                                param.getSourceFile(),
                                this.environment(param),
                            ),
                            this.resolver.type(actual, actual.getSourceFile(), site.env),
                            site.bindings!,
                            site.node,
                        );
                    }
                });
                const bases: NonNullable<Plan['base']>[] = [];

                for (let base = plan.base; base; base = base.plan.base) {
                    bases.push(base);
                }

                for (const base of bases.reverse()) {
                    for (const [key, pattern] of base.bindings) {
                        const actual = site.bindings!.get(key);

                        if (actual) {
                            this.unify(pattern, actual, site.bindings!, site.node);
                        }
                    }
                }
            }

            const local = this.targets.environment({ node: plan.node, bindings: site.bindings! });

            for (let i = 0; i < (plan.node.typeParameters?.length ?? 0); i++) {
                const param = plan.node.typeParameters![i];
                const key = plan.env.get(param.name.text)!.key;
                const arg = site.typeArgs?.[i];
                const actual =
                    site.bindings!.get(key) ??
                    (arg
                        ? partial
                            ? this.resolver.lazy(arg, arg.getSourceFile(), site.env!)
                            : this.resolver.type(arg, arg.getSourceFile(), site.env!)
                        : param.default
                          ? this.resolver.type(param.default, param.getSourceFile(), local)
                          : undefined);

                if (!actual && partial) {
                    continue;
                }

                if (!actual) {
                    fail(
                        site.node,
                        `Cannot infer ${param.name.text}; supply an explicit generic argument.`,
                    );
                }

                site.bindings!.set(key, actual);
                local.set(param.name.text, actual);
            }

            site.bound = !partial;
        }

        return site.bindings!;
    }

    unify(
        pattern: TypeValue,
        actual: TypeValue,
        bindings: Map<string, TypeValue>,
        node: ts.Node,
        seen = new Set<string>(),
    ): void {
        const key = `${pattern.key}:${actual.key}`;

        if (seen.has(key)) {
            return;
        }

        seen.add(key);

        if (pattern.kind === 'parameter') {
            const previous = bindings.get(pattern.key);

            if (previous && previous.key !== actual.key) {
                fail(
                    node,
                    `Conflicting inference for ${pattern.name}; supply an explicit type argument.`,
                );
            }

            bindings.set(pattern.key, actual);
        } else if (
            pattern.application &&
            actual.application &&
            pattern.application.declaration === actual.application.declaration
        ) {
            pattern.application.arguments.forEach((type, index) =>
                this.unify(type, actual.application!.arguments[index], bindings, node, seen),
            );
        } else if (pattern.fields && actual.fields) {
            for (const [name, property] of pattern.fields) {
                const field = actual.fields.get(name);

                if (field) {
                    this.unify(property.type, field.type, bindings, node, seen);
                }
            }
        } else if (
            pattern.values &&
            actual.values &&
            pattern.values.length === actual.values.length
        ) {
            pattern.values.forEach((type, index) =>
                this.unify(type, actual.values![index], bindings, node, seen),
            );
        }
    }

    owner(node: ts.Node): Owner | undefined {
        for (let parent = node.parent; parent; parent = parent.parent) {
            if (
                (callable(parent) || ts.isClassDeclaration(parent)) &&
                parent.typeParameters?.length
            ) {
                return parent;
            }
        }

        return;
    }

    environment(node: ts.Node): TypeEnvironment {
        const owners: Owner[] = [];

        for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
            if (
                (callable(parent) || ts.isClassDeclaration(parent)) &&
                parent.typeParameters?.length
            ) {
                owners.push(parent);
            }
        }

        const env: TypeEnvironment = new Map();

        for (const owner of owners.reverse()) {
            for (const param of owner.typeParameters!) {
                env.set(param.name.text, this.resolver.parameter(param.name.text, owner));
            }
        }

        return env;
    }

    plan(node: Owner): Plan {
        let plan = this.plans.get(node);

        if (!plan) {
            plan = { node, env: this.environment(node), requirements: new Map(), names: new Map() };
            this.plans.set(node, plan);

            if (ts.isClassDeclaration(node)) {
                const heritage = node.heritageClauses?.find(
                    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
                )?.types[0];

                if (heritage) {
                    const target = this.targets.target(
                        heritage.expression,
                        node.getSourceFile(),
                        plan.env,
                    );

                    if (target && ts.isClassDeclaration(target.node)) {
                        const base = this.plan(target.node);

                        for (
                            let ancestor: Plan | undefined = base;
                            ancestor;
                            ancestor = ancestor.base?.plan
                        ) {
                            if (ancestor === plan) {
                                fail(heritage, 'Circular class inheritance.');
                            }
                        }

                        const args = this.resolver.arguments(
                            target.node.typeParameters,
                            heritage.typeArguments,
                            node.getSourceFile(),
                            plan.env,
                            target.node,
                        );
                        const bindings = new Map<string, TypeValue>();

                        for (const [name, type] of args) {
                            bindings.set(base.env.get(name)!.key, type);
                        }

                        plan.base = { plan: base, bindings };
                        this.scan(target.node.getSourceFile());
                    }
                }
            }
        }

        return plan;
    }

    protobufFunction(
        expression: ts.Expression,
        source: ts.SourceFile,
    ): Requirement['fn'] | undefined {
        let name: string | undefined;

        if (ts.isIdentifier(expression)) {
            const declaration = this.context.lookup(expression.text, expression, source);
            name = declaration ? runtimeImportName(declaration.node) : undefined;
        } else if (
            ts.isPropertyAccessExpression(expression) &&
            ts.isIdentifier(expression.expression)
        ) {
            const declaration = this.context.lookup(expression.expression.text, expression, source);

            if (
                declaration &&
                ts.isNamespaceImport(declaration.node) &&
                (declaration.node.parent.parent.moduleSpecifier as ts.StringLiteral).text ===
                    packageName
            ) {
                name = expression.name.text;
            }
        }

        return name === 'protobuf_encode' || name === 'protobuf_decode' ? name : undefined;
    }

    parameters(node: Owner): readonly ts.ParameterDeclaration[] | undefined {
        const parameters = ts.isClassDeclaration(node)
            ? (constructorOf(node)?.parameters ??
              (this.plan(node).base ? this.parameters(this.plan(node).base!.plan.node) : undefined))
            : node.parameters;
        return parameters?.filter(
            (param) => !ts.isIdentifier(param.name) || param.name.text !== 'this',
        );
    }
    parameterName(plan: Plan, key: string): string {
        let name = plan.names.get(key);

        if (!name) {
            name = unique(
                plan.node.getSourceFile(),
                `__pb_codec_${plan.node.pos}_${plan.names.size}`.replace(/-/g, '_'),
            );
            plan.names.set(key, name);
        }

        return name;
    }
}
