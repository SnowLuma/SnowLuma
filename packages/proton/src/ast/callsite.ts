import ts from 'typescript';

export type CanonicalProtobufFn = 'protobuf_encode' | 'protobuf_decode';

const CANONICAL = new Set<CanonicalProtobufFn>(['protobuf_encode', 'protobuf_decode']);
const PROTOBUF_RUNTIME_MODULES = new Set([
  '@snowluma/proton',
]);

export interface ProtobufImportBindings {
  identifierToCanonical: Map<string, CanonicalProtobufFn>;
  namespaceAliases: Set<string>;
  blockedLegacyCanonical: Set<CanonicalProtobufFn>;
  hasRuntimeImport: boolean;
}

export interface ProtobufCallSite {
  fnName: CanonicalProtobufFn;
  exprStart: number;
  typeArgsEnd: number;
  firstTypeArg: ts.TypeNode;
  line: number;
  column: number;
}

// Same shape as utils.ts' `resolverCache`: bindings are deterministic per
// SourceFile and queried from analyzer + replacer + wrapper detector +
// import resolver, so memoise by node identity.
const bindingsCache = new WeakMap<ts.SourceFile, ProtobufImportBindings>();

export function collectProtobufImportBindings(sf: ts.SourceFile): ProtobufImportBindings {
  const cached = bindingsCache.get(sf);
  if (cached) return cached;

  const identifierToCanonical = new Map<string, CanonicalProtobufFn>();
  const namespaceAliases = new Set<string>();
  const blockedLegacyCanonical = new Set<CanonicalProtobufFn>();
  let hasRuntimeImport = false;

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const fromRuntime = PROTOBUF_RUNTIME_MODULES.has(stmt.moduleSpecifier.text);
    if (fromRuntime) hasRuntimeImport = true;

    const bindings = stmt.importClause.namedBindings;
    const defaultImport = stmt.importClause.name?.text;
    if (defaultImport && CANONICAL.has(defaultImport as CanonicalProtobufFn) && !fromRuntime) {
      blockedLegacyCanonical.add(defaultImport as CanonicalProtobufFn);
    }

    if (!bindings) continue;

    if (ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (fromRuntime && CANONICAL.has(imported as CanonicalProtobufFn)) {
          identifierToCanonical.set(el.name.text, imported as CanonicalProtobufFn);
          continue;
        }

        if (CANONICAL.has(el.name.text as CanonicalProtobufFn)) {
          blockedLegacyCanonical.add(el.name.text as CanonicalProtobufFn);
        }
      }
      continue;
    }

    if (fromRuntime && ts.isNamespaceImport(bindings)) {
      namespaceAliases.add(bindings.name.text);
    } else if (CANONICAL.has(bindings.name.text as CanonicalProtobufFn)) {
      blockedLegacyCanonical.add(bindings.name.text as CanonicalProtobufFn);
    }
  }

  const result: ProtobufImportBindings = { identifierToCanonical, namespaceAliases, blockedLegacyCanonical, hasRuntimeImport };
  bindingsCache.set(sf, result);
  return result;
}

interface MatchOptions {
  allowLegacyUnboundCanonical?: boolean;
}

export function matchProtobufCallSite(
  node: ts.CallExpression,
  sf: ts.SourceFile,
  bindings: ProtobufImportBindings,
  options?: MatchOptions,
): ProtobufCallSite | null {
  const ta = node.typeArguments;
  if (!ta?.length) return null;

  const expr = node.expression;
  const allowLegacy = options?.allowLegacyUnboundCanonical === true;

  let fnName: CanonicalProtobufFn | null = null;
  let exprStart = expr.getStart(sf);

  if (ts.isIdentifier(expr)) {
    fnName = bindings.identifierToCanonical.get(expr.text) ?? null;
    if (
      !fnName &&
      allowLegacy &&
      !bindings.hasRuntimeImport &&
      CANONICAL.has(expr.text as CanonicalProtobufFn) &&
      !bindings.blockedLegacyCanonical.has(expr.text as CanonicalProtobufFn)
    ) {
      fnName = expr.text as CanonicalProtobufFn;
    }
  } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    if (bindings.namespaceAliases.has(expr.expression.text) && CANONICAL.has(expr.name.text as CanonicalProtobufFn)) {
      fnName = expr.name.text as CanonicalProtobufFn;
      exprStart = expr.getStart(sf);
    }
  }

  if (!fnName) return null;
  const lc = sf.getLineAndCharacterOfPosition(exprStart);

  return {
    fnName,
    exprStart,
    typeArgsEnd: ta.end + 1,
    firstTypeArg: ta[0],
    line: lc.line + 1,
    column: lc.character + 1,
  };
}
