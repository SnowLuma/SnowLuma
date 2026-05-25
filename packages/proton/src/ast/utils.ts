import ts from 'typescript';

export type ImportedTypeNameResolver = (name: string) => string;

function identityImportedTypeName(name: string): string {
  return name;
}

// Synthetic type-arg nodes (produced by wrapper-binding instantiation) live in
// their own SourceFile, not in the caller's. Anyone that needs to read text or
// resolve imports against such a node must use the registered SF; otherwise
// `node.getText(callerSf)` reads garbage from the wrong buffer.
const syntheticTypeSourceFiles = new WeakMap<ts.TypeNode, ts.SourceFile>();

export function registerSyntheticTypeSourceFile(node: ts.TypeNode, sf: ts.SourceFile): void {
  syntheticTypeSourceFiles.set(node, sf);
}

export function resolveSourceFileForTypeNode(node: ts.TypeNode, fallback: ts.SourceFile): ts.SourceFile {
  return syntheticTypeSourceFiles.get(node) ?? fallback;
}

// TS 5.9+ removed ts.isKeywordTypeNode — manual kind-based check
const KEYWORD_TYPE_KINDS = new Set([
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.AnyKeyword,
  ts.SyntaxKind.VoidKeyword,
  ts.SyntaxKind.UndefinedKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.UnknownKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.ObjectKeyword,
]);

export function isKeywordTypeNode(node: ts.Node): boolean {
  return KEYWORD_TYPE_KINDS.has(node.kind);
}

// Imported-name resolvers are deterministic for a given SourceFile but get
// asked for in a half-dozen places per `transform()` call (analyzer,
// monomorphizer, replacer, subclass resolver, …). Cache by node identity
// so the per-SF statement walk runs once instead of N times.
const resolverCache = new WeakMap<ts.SourceFile, ImportedTypeNameResolver>();

export function createImportedTypeNameResolver(sf: ts.SourceFile): ImportedTypeNameResolver {
  const cached = resolverCache.get(sf);
  if (cached) return cached;

  const localToImported = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const bindings = stmt.importClause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;

    for (const el of bindings.elements) {
      localToImported.set(el.name.text, (el.propertyName ?? el.name).text);
    }
  }

  const resolver: ImportedTypeNameResolver = (name) => localToImported.get(name) ?? name;
  resolverCache.set(sf, resolver);
  return resolver;
}

/**
 * Deterministic mangled name for a type node.
 *   `Foo`                → `Foo`
 *   `Foo<string>`        → `Foo__string`
 *   `Foo<Bar<uint_32>>`  → `Foo__Bar__uint_32`
 *
 * If `typeNode` is a synthetic node produced by wrapper-binding instantiation,
 * its registered source file is used automatically so `getText()` returns
 * the substituted type text rather than garbage from `sf`.
 */
export function typeNodeToMangledName(
  typeNode: ts.TypeNode,
  sf: ts.SourceFile,
  resolveImportedTypeName: ImportedTypeNameResolver = identityImportedTypeName,
): string {
  const effectiveSf = resolveSourceFileForTypeNode(typeNode, sf);
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const base = resolveImportedTypeName(typeNode.typeName.text);
    if (typeNode.typeArguments && typeNode.typeArguments.length > 0) {
      const args = typeNode.typeArguments.map(a => typeNodeToMangledName(a, effectiveSf, resolveImportedTypeName));
      return base + '__' + args.join('__');
    }
    return base;
  }
  if (isKeywordTypeNode(typeNode)) return typeNode.getText(effectiveSf);
  return typeNode.getText(effectiveSf);
}
