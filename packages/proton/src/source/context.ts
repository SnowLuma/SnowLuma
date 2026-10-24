import { packageName } from '../package.js';
import ts from 'typescript';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface DeclarationRef {
    node: ts.Declaration;
    source: ts.SourceFile;
}

export function runtimeImportName(node: ts.Declaration): string | undefined {
    const declaration = ts.isImportSpecifier(node)
        ? node.parent.parent.parent
        : ts.isExportSpecifier(node)
          ? node.parent.parent
          : undefined;

    if (
        declaration?.moduleSpecifier &&
        ts.isStringLiteral(declaration.moduleSpecifier) &&
        declaration.moduleSpecifier.text === packageName
    ) {
        return (
            (node as ts.ImportSpecifier | ts.ExportSpecifier).propertyName?.text ??
            (node as ts.ImportSpecifier | ts.ExportSpecifier).name.text
        );
    }

    return;
}

const extensions = ['.ts', '.tsx', '.mts', '.cts', '/index.ts', '/index.tsx'];
export const normalizePath = (path: string): string => resolve(path).replace(/\\/g, '/');

/** One parse per source revision, shared by schema and generic-call analysis. */
export class SourceContext {
    readonly files = new Map<string, ts.SourceFile>();
    revision = 0;
    private readonly modules = new Map<string, string | null>();
    private readonly names = new WeakMap<ts.Node, Map<string, ts.Declaration>>();
    private readonly typeNames = new WeakMap<ts.Node, Map<string, ts.Declaration>>();
    private readonly options = new Map<string, ts.CompilerOptions>();

    clear(): void {
        this.files.clear();
        this.modules.clear();
        this.options.clear();
    }

    source(path: string, code?: string): ts.SourceFile {
        const key = normalizePath(path);
        const cached = this.files.get(key);

        if (cached && (code === undefined || cached.text === code)) {
            return cached;
        }

        if (cached) {
            this.revision++;
        }

        const source = ts.createSourceFile(
            key,
            code ?? readFileSync(key, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
        );
        this.files.set(key, source);
        return source;
    }

    module(specifier: string, source: ts.SourceFile): ts.SourceFile | undefined {
        if (specifier === packageName) {
            return;
        }

        const key = `${source.fileName}:${specifier}`;
        let path = this.modules.get(key);

        if (path === undefined) {
            if (specifier.startsWith('.')) {
                const base = normalizePath(resolve(dirname(source.fileName), specifier));
                const stem = base.replace(/\.(?:mjs|cjs|js)$/, '');
                path =
                    [base, ...extensions.map((ext) => stem + ext)].find((candidate) => {
                        try {
                            return statSync(candidate).isFile();
                        } catch {
                            return false;
                        }
                    }) ?? null;
            } else {
                const directory = dirname(source.fileName);
                let options = this.options.get(directory);

                if (!options) {
                    const config = ts.findConfigFile(directory, ts.sys.fileExists);
                    options = config ? this.options.get(config) : undefined;
                    options ??= config
                        ? ts.parseJsonConfigFileContent(
                              ts.readConfigFile(config, ts.sys.readFile).config,
                              { ...ts.sys, readDirectory: () => [] },
                              dirname(config),
                          ).options
                        : {};

                    if (config) {
                        this.options.set(config, options);
                    }

                    this.options.set(directory, options);
                }

                path =
                    ts.resolveModuleName(specifier, source.fileName, options, ts.sys).resolvedModule
                        ?.resolvedFileName ?? null;
            }

            this.modules.set(key, path);
        }

        return path ? this.source(path) : undefined;
    }

    lookup(
        name: string,
        location: ts.Node,
        source = location.getSourceFile(),
        typeOnly = false,
    ): DeclarationRef | undefined {
        for (let scope: ts.Node | undefined = location; scope; scope = scope.parent) {
            if (!typeOnly && ts.isFunctionLike(scope)) {
                const parameter = scope.parameters.find(
                    (param) => ts.isIdentifier(param.name) && param.name.text === name,
                );

                if (parameter) {
                    return { node: parameter, source };
                }

                for (const param of scope.parameters) {
                    if (!ts.isObjectBindingPattern(param.name)) {
                        continue;
                    }

                    const element = param.name.elements.find(
                        (element) => ts.isIdentifier(element.name) && element.name.text === name,
                    );

                    if (element) {
                        return { node: element, source };
                    }
                }
            }

            if (!ts.isSourceFile(scope) && !ts.isBlock(scope) && !ts.isModuleBlock(scope)) {
                continue;
            }

            const declaration = this.declarations(scope, typeOnly).get(name);

            if (declaration) {
                return this.follow(declaration, source, new Set(), typeOnly);
            }
        }

        const declaration = this.declarations(source, typeOnly).get(name);
        return declaration ? this.follow(declaration, source, new Set(), typeOnly) : undefined;
    }

    typeName(name: ts.EntityName, source: ts.SourceFile): DeclarationRef | undefined {
        return this.reference(name, source, true);
    }

    reference(
        name: ts.EntityName | ts.Expression,
        source: ts.SourceFile,
        typeOnly = false,
    ): DeclarationRef | undefined {
        if (ts.isIdentifier(name)) {
            return this.lookup(name.text, name, source, typeOnly);
        }

        if (!ts.isQualifiedName(name) && !ts.isPropertyAccessExpression(name)) {
            return;
        }

        const left = this.reference(
            ts.isQualifiedName(name) ? name.left : name.expression,
            source,
            typeOnly,
        );
        const right = ts.isQualifiedName(name) ? name.right : name.name;

        if (!left) {
            return;
        }

        if (ts.isNamespaceImport(left.node)) {
            const declaration = left.node.parent.parent;
            const imported = this.module(
                (declaration.moduleSpecifier as ts.StringLiteral).text,
                left.source,
            );
            return imported ? this.exported(right.text, imported, new Set(), typeOnly) : undefined;
        }

        if (
            ts.isModuleDeclaration(left.node) &&
            left.node.body &&
            ts.isModuleBlock(left.node.body)
        ) {
            const declaration = this.declarations(left.node.body, typeOnly).get(right.text);
            return declaration ? { node: declaration, source: left.source } : undefined;
        }

        return;
    }

    private declarations(
        scope: ts.SourceFile | ts.Block | ts.ModuleBlock,
        typeOnly = false,
    ): Map<string, ts.Declaration> {
        const cache = typeOnly ? this.typeNames : this.names;
        let names = cache.get(scope);

        if (names) {
            return names;
        }

        names = new Map();

        for (const statement of scope.statements) {
            if (ts.isVariableStatement(statement)) {
                if (typeOnly) {
                    continue;
                }

                for (const declaration of statement.declarationList.declarations) {
                    if (ts.isIdentifier(declaration.name)) {
                        names.set(declaration.name.text, declaration);
                    } else if (ts.isObjectBindingPattern(declaration.name)) {
                        for (const element of declaration.name.elements) {
                            if (ts.isIdentifier(element.name)) {
                                names.set(element.name.text, element);
                            }
                        }
                    }
                }
            } else if (ts.isImportDeclaration(statement)) {
                const clause = statement.importClause;

                if (clause?.name) {
                    names.set(clause.name.text, clause);
                }

                const bindings = clause?.namedBindings;

                if (bindings && ts.isNamedImports(bindings)) {
                    for (const binding of bindings.elements) {
                        names.set(binding.name.text, binding);
                    }
                } else if (bindings) {
                    names.set(bindings.name.text, bindings);
                }
            } else if (
                'name' in statement &&
                statement.name &&
                ts.isIdentifier(statement.name as ts.Node)
            ) {
                if (typeOnly && ts.isFunctionDeclaration(statement)) {
                    continue;
                }

                if (
                    !typeOnly &&
                    (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement))
                ) {
                    continue;
                }

                names.set(
                    (statement.name as ts.Identifier).text,
                    statement as unknown as ts.Declaration,
                );
            }
        }

        cache.set(scope, names);
        return names;
    }

    private follow(
        node: ts.Declaration,
        source: ts.SourceFile,
        seen: Set<ts.Node>,
        typeOnly = false,
    ): DeclarationRef | undefined {
        if (seen.has(node)) {
            return;
        }

        seen.add(node);

        if (ts.isImportSpecifier(node)) {
            const declaration = node.parent.parent.parent;
            const imported = this.module(
                (declaration.moduleSpecifier as ts.StringLiteral).text,
                source,
            );

            if (imported) {
                return this.exported(
                    (node.propertyName ?? node.name).text,
                    imported,
                    seen,
                    typeOnly,
                );
            }
        } else if (ts.isImportClause(node)) {
            const imported = this.module(
                (node.parent.moduleSpecifier as ts.StringLiteral).text,
                source,
            );

            if (imported) {
                return this.exported('default', imported, seen, typeOnly);
            }
        }

        return { node, source };
    }

    exported(
        name: string,
        source: ts.SourceFile,
        seen = new Set<ts.Node>(),
        typeOnly = false,
    ): DeclarationRef | undefined {
        const local = this.declarations(source, typeOnly).get(name);

        if (local) {
            return this.follow(local, source, seen, typeOnly);
        }

        for (const statement of source.statements) {
            if (name === 'default') {
                if (
                    (ts.isClassDeclaration(statement) ||
                        ts.isFunctionDeclaration(statement) ||
                        ts.isInterfaceDeclaration(statement)) &&
                    statement.modifiers?.some(
                        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
                    )
                ) {
                    return { node: statement, source };
                }

                if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
                    return this.lookup(
                        statement.expression.text,
                        statement.expression,
                        source,
                        typeOnly,
                    );
                }
            }

            if (!ts.isExportDeclaration(statement) || seen.has(statement)) {
                continue;
            }

            seen.add(statement);
            const imported =
                statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
                    ? this.module(statement.moduleSpecifier.text, source)
                    : source;

            if (!imported) {
                if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                    const element = statement.exportClause.elements.find(
                        (element) => element.name.text === name,
                    );

                    if (element && runtimeImportName(element)) {
                        return { node: element, source };
                    }
                }

                continue;
            }

            if (!statement.exportClause) {
                const ref = this.exported(name, imported, seen, typeOnly);

                if (ref) {
                    return ref;
                }
            } else if (ts.isNamedExports(statement.exportClause)) {
                const element = statement.exportClause.elements.find((el) => el.name.text === name);

                if (element) {
                    return this.exported(
                        (element.propertyName ?? element.name).text,
                        imported,
                        seen,
                        typeOnly,
                    );
                }
            }
        }

        return;
    }
}

export function fail(node: ts.Node, message: string): never {
    const source = node.getSourceFile();
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    throw new Error(
        `[${packageName}] ${source.fileName}:${position.line + 1}:${position.character + 1}: ${message}`,
    );
}
