import { codecIndex, insertArguments, insertParameters, unique } from './edits.js';
import ts from 'typescript';
import { SourceContext, fail } from '../source/context.js';
import { SchemaResolver } from '../schema/resolver.js';
import { generateCode } from '../codegen/generator.js';

import { constructorOf, type Plan, type Requirement, type Edit } from './model.js';
import { CallAnalysis } from './analysis.js';
import { validateSource } from './validate.js';

/** Generic calls receive generated codec functions, preserving the original body and closure. */
export class ProtobufCompiler {
    readonly context = new SourceContext();
    private resolver = new SchemaResolver(this.context);
    private graph = new CallAnalysis(this.context, this.resolver);
    private output = new Map<string, { source: string; code: string | null }>();
    private entries = new Set<string>();

    clear(): void {
        this.reset();
        this.entries.clear();
    }

    private reset(): void {
        this.context.clear();
        this.output.clear();
        this.resolver = new SchemaResolver(this.context);
        this.graph = new CallAnalysis(this.context, this.resolver);
    }

    prepare(files: Iterable<string>): void {
        for (const file of files) {
            this.entries.add(file);
        }

        try {
            for (const file of this.entries) {
                this.graph.scan(this.context.source(file));
            }

            this.graph.callbacks.collect();
            this.graph.propagate();
        } catch (error) {
            this.reset();
            throw error;
        }
    }

    compile(code: string, file: string): string | null {
        try {
            return this.transform(code, file);
        } catch (error) {
            this.reset();
            throw error;
        }
    }

    private transform(code: string, file: string): string | null {
        const cached = this.output.get(file);

        if (cached?.source === code) {
            return cached.code;
        }

        const revision = this.context.revision;
        const source = this.context.source(file, code);

        if (!this.graph.sites.size && this.entries.size) {
            this.prepare(this.entries);
        }

        if (cached || this.context.revision !== revision) {
            const entries = [...this.entries];
            this.clear();
            this.context.files.set(source.fileName, source);
            this.prepare(entries);
        }

        this.graph.scan(source);
        this.graph.callbacks.collect();
        this.graph.propagate();
        validateSource(this.graph, source);
        const edits: Edit[] = [];
        const encodeRoots = new Set<string>();
        const decodeRoots = new Set<string>();

        const reference = (requirement: Requirement, owner?: Plan, constructor = false): string => {
            if (requirement.type.dynamic) {
                if (!owner) {
                    fail(
                        requirement.node,
                        'Unresolved generic codec outside a generic function or class.',
                    );
                }

                const name = this.graph.parameterName(owner, requirement.key);
                return ts.isClassDeclaration(owner.node) && !constructor ? `this.#${name}` : name;
            }

            const name = this.resolver.message(requirement.type, requirement.node);
            (requirement.fn === 'protobuf_encode' ? encodeRoots : decodeRoots).add(name);
            return `${requirement.fn}_${name}`;
        };

        for (const site of this.graph.sites.get(source) ?? []) {
            let constructor = false;

            for (
                let parent: ts.Node | undefined = site.node;
                parent && parent !== site.owner?.node;
                parent = parent.parent
            ) {
                if (ts.isConstructorDeclaration(parent)) {
                    constructor = true;
                    break;
                }
            }

            if (site.direct) {
                edits.push({
                    start: site.node.expression.getStart(source),
                    end: site.node.typeArguments
                        ? site.node.typeArguments.end + 1
                        : site.node.expression.end,
                    text: reference(site.direct, site.owner, constructor),
                });
            } else if (site.target?.requirements.size) {
                const args = [...site.target.requirements.values()].map((req) =>
                    reference(
                        this.graph.instantiate(req, this.graph.bindings(site)),
                        site.owner,
                        constructor,
                    ),
                );
                insertArguments(
                    site.node,
                    this.graph.parameters(site.target.node),
                    args,
                    edits,
                    source,
                );
            }
        }

        this.graph.callbacks.emit(source, reference, edits);

        for (const plan of this.graph.plans.values()) {
            if (
                ts.isTypeNode(plan.node) ||
                ts.isCallSignatureDeclaration(plan.node) ||
                plan.node.getSourceFile() !== source ||
                (plan.requirements.size === 0 && !plan.base?.plan.requirements.size)
            ) {
                continue;
            }

            const names = [...plan.requirements.keys()].map((key) =>
                this.graph.parameterName(plan, key),
            );

            if (ts.isClassDeclaration(plan.node)) {
                const constructor = constructorOf(plan.node);
                const assignments = names.map((name) => `this.#${name} = ${name};`).join('\n');

                if (names.length) {
                    edits.push({
                        start: plan.node.members.pos,
                        end: plan.node.members.pos,
                        text: '\n' + names.map((name) => `#${name};`).join('\n') + '\n',
                    });
                }

                if (constructor?.body) {
                    if (names.length) {
                        insertParameters(constructor.parameters, names, edits, source);
                    }

                    const superStatement = constructor.body.statements.find(
                        (statement) =>
                            ts.isExpressionStatement(statement) &&
                            ts.isCallExpression(statement.expression) &&
                            statement.expression.expression.kind === ts.SyntaxKind.SuperKeyword,
                    );

                    if (plan.base && !superStatement) {
                        fail(
                            constructor,
                            'Generic derived constructors require a top-level super(...) call.',
                        );
                    }

                    const position = superStatement?.end ?? constructor.body.getStart(source) + 1;
                    edits.push({ start: position, end: position, text: assignments });
                } else if (plan.base) {
                    const inherited = this.graph.parameters(plan.base.plan.node);
                    const count = codecIndex(inherited);
                    const argsName = unique(source, '__pb_constructor_args');
                    const locals = names
                        .map((name, i) => `const ${name} = ${argsName}[${count + i}];`)
                        .join('\n');
                    const codecs = [...plan.base.plan.requirements.values()].map((req) =>
                        reference(this.graph.instantiate(req, plan.base!.bindings), plan, true),
                    );
                    const forwarded = [
                        `...${argsName}.slice(0, ${count})`,
                        ...codecs,
                        `...${argsName}.slice(${count + names.length})`,
                    ];
                    edits.push({
                        start: plan.node.members.pos,
                        end: plan.node.members.pos,
                        text: `\nconstructor(...${argsName}) { ${locals}\nsuper(${forwarded.join(', ')});\n${assignments} }\n`,
                    });
                } else {
                    edits.push({
                        start: plan.node.members.pos,
                        end: plan.node.members.pos,
                        text: `\nconstructor(${names.map((name) => name + ' = undefined').join(', ')}) { ${assignments} }\n`,
                    });
                }
            } else {
                insertParameters(plan.node.parameters, names, edits, source);
            }
        }

        if (!edits.length) {
            this.output.set(file, { source: code, code: null });
            return null;
        }

        edits.sort((a, b) => a.start - b.start || (a.order ?? 0) - (b.order ?? 0) || a.end - b.end);
        const parts: string[] = [];
        let offset = 0;

        for (const edit of edits) {
            if (edit.start < offset) {
                throw new Error('Overlapping protobuf compiler edits.');
            }

            offset = edit.end;
        }

        let generated = generateCode(this.resolver.registry, {
            encodeRoots,
            decodeRoots,
        });
        // Keep generated identifiers out of the user's namespace, including helper names.
        const prefix = unique(source, '__pb_generated_');
        const generatedNames = new Set(
            [
                ...generated.matchAll(
                    /\b(?:function|const|let)\s+((?:protobuf_(?:encode|decode)_|__)[\p{ID_Continue}$]+)/gu,
                ),
            ].map((match) => match[1]),
        );
        const hasCollision = [...generatedNames].some((name) => source.text.includes(name));

        const renamed = (text: string): string => {
            if (!hasCollision) {
                return text;
            }

            const scanner = ts.createScanner(
                ts.ScriptTarget.Latest,
                false,
                ts.LanguageVariant.Standard,
                text,
            );
            const chunks: string[] = [];
            let position = 0;

            for (
                let token = scanner.scan();
                token !== ts.SyntaxKind.EndOfFileToken;
                token = scanner.scan()
            ) {
                if (
                    token !== ts.SyntaxKind.Identifier ||
                    !generatedNames.has(scanner.getTokenText())
                ) {
                    continue;
                }

                chunks.push(
                    text.slice(position, scanner.getTokenPos()),
                    prefix + scanner.getTokenText(),
                );
                position = scanner.getTextPos();
            }

            return chunks.join('') + text.slice(position);
        };

        generated = renamed(generated);

        // Rename only inserted codec references, never arbitrary source strings or user identifiers.
        for (const edit of edits) {
            edit.text = renamed(edit.text);
        }

        parts.length = 0;
        offset = 0;

        for (const edit of edits) {
            parts.push(code.slice(offset, edit.start), edit.text);
            offset = edit.end;
        }

        parts.push(code.slice(offset));
        const rewritten = parts.join('');
        let preambleAt = code.startsWith('#!') ? code.indexOf('\n') + 1 : 0;

        for (const statement of source.statements) {
            if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
                break;
            }

            preambleAt = statement.end;
        }

        const transformed =
            rewritten.slice(0, preambleAt) + '\n' + generated + '\n' + rewritten.slice(preambleAt);
        this.output.set(file, { source: code, code: transformed });
        return transformed;
    }
}
