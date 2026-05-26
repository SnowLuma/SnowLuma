import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import ts from 'typescript';
import { getCallableName } from './ast-helpers.js';
import { collectProtobufImportBindings, matchProtobufCallSite } from './callsite.js';
import { collectGenericInterface, collectInterface } from './collector.js';
import { PRIMITIVE_TYPE_MAP, type GenericProtobufTemplate, type ProtobufMessage } from './types.js';
import { createImportedTypeNameResolver, isKeywordTypeNode, type ImportedTypeNameResolver } from './utils.js';
import { instantiateWrapperTypePattern, type WrapperBinding } from './wrapper-binding.js';
export type { WrapperBinding } from './wrapper-binding.js';

export interface ParsedFileEntry {
  filePath: string;
  sourceFile: ts.SourceFile;
  dependencyFiles: string[];
  concrete: ProtobufMessage[];
  templates: Map<string, GenericProtobufTemplate>;
  importedTypeSources: Map<string, string>;
  exportAllTypeSources: Map<string, string>;
  resolveImportedTypeName: ImportedTypeNameResolver;
  exportedWrappers: Map<string, WrapperBinding>;
}

export interface ImportedDefinitions {
  sourceFile: ts.SourceFile;
  dependencyFiles: string[];
  concrete: ProtobufMessage[];
  templates: Map<string, GenericProtobufTemplate>;
  wrapperBindings: Map<string, WrapperBinding>;
}

interface ImportClause {
  importedName: string;
  localName: string;
  specifier: string;
}

const importClausesCache = new WeakMap<ts.SourceFile, ImportClause[]>();
const valueImportClausesCache = new WeakMap<ts.SourceFile, ImportClause[]>();
const exportAllSpecifiersCache = new WeakMap<ts.SourceFile, string[]>();

function collectImportClauses(sf: ts.SourceFile, valueOnly: boolean): ImportClause[] {
  const cache = valueOnly ? valueImportClausesCache : importClausesCache;
  const cached = cache.get(sf);
  if (cached) return cached;

  const result: ImportClause[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    if (valueOnly && stmt.importClause.isTypeOnly) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    const specifier = spec.text;

    const named = stmt.importClause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        if (valueOnly && el.isTypeOnly) continue;
        result.push({
          importedName: (el.propertyName ?? el.name).text,
          localName: el.name.text,
          specifier,
        });
      }
    }
  }
  cache.set(sf, result);
  return result;
}

/** All named imports (type + value). */
const extractImports = (sf: ts.SourceFile): ImportClause[] => collectImportClauses(sf, false);

/** Value-only named imports. Type-only imports can't introduce a wrapper function
 *  and shouldn't trigger eager source-file parsing. */
const extractValueImports = (sf: ts.SourceFile): ImportClause[] => collectImportClauses(sf, true);

function extractExportAllSpecifiers(sf: ts.SourceFile): string[] {
  const cached = exportAllSpecifiersCache.get(sf);
  if (cached) return cached;

  const result: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.exportClause) continue;
    const spec = stmt.moduleSpecifier;
    if (spec && ts.isStringLiteral(spec)) result.push(spec.text);
  }
  exportAllSpecifiersCache.set(sf, result);
  return result;
}

// Bundler resolution for bare specifiers: supports package.json exports,
// workspace symlinks, and path aliases without requiring extensions.
const BARE_SPECIFIER_COMPILER_OPTIONS: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.Latest,
  allowImportingTsExtensions: true,
};

// Per-process cache for `ts.resolveModuleName`. Hot paths (rebuild on
// HMR) call this hundreds of times — without the cache each call
// re-walks `node_modules` and `package.json` lookups.
let bareModuleResolutionCache: ts.ModuleResolutionCache | null = null;

function getBareModuleResolutionCache(): ts.ModuleResolutionCache {
  if (!bareModuleResolutionCache) {
    bareModuleResolutionCache = ts.createModuleResolutionCache(
      process.cwd(),
      (s) => s,
      BARE_SPECIFIER_COMPILER_OPTIONS,
    );
  }
  return bareModuleResolutionCache;
}

/** Resolve a specifier (relative or bare) to an absolute `.ts` source path.
 *  Returns `null` for non-.ts files (`.d.ts`, `.js`) or unresolved paths.
 *  Relative specifiers use direct file probing; bare specifiers use TS bundler
 *  resolution so workspaces, path aliases, and `package.json` exports work.
 *  Only `.ts` source is accepted — `.d.ts` strips the `pb<>` type arguments. */
function resolveModulePath(specifier: string, importerPath: string): string | null {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(importerPath), specifier);
    if (base.endsWith('.ts') && existsSync(base)) return base;

    // Try appending .ts
    const withTs = base + '.ts';
    if (existsSync(withTs)) return withTs;

    // Try as directory with index.ts
    const indexTs = resolve(base, 'index.ts');
    if (existsSync(indexTs)) return indexTs;

    return null;
  }

  const result = ts.resolveModuleName(
    specifier,
    importerPath,
    BARE_SPECIFIER_COMPILER_OPTIONS,
    ts.sys,
    getBareModuleResolutionCache(),
  );
  const resolved = result.resolvedModule;
  if (!resolved) return null;
  // Only accept .ts source — see doc comment above for why.
  if (resolved.extension !== ts.Extension.Ts) return null;
  return resolved.resolvedFileName;
}

/** Resolve `name` (imported into `sf`) to the absolute path of the `.ts`
 *  module that declares it. Returns null for local symbols, type-only imports,
 *  or unresolved specifiers. Used by the AST-only subclass-wrapper resolver to
 *  walk extends edges across file boundaries. */
export function findImportSourcePath(sf: ts.SourceFile, name: string, fromPath: string): string | null {
  for (const imp of collectImportClauses(sf, false)) {
    if (imp.importedName === name || imp.localName === name) {
      return resolveModulePath(imp.specifier, fromPath);
    }
  }
  return null;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}

function matchForwardedProtobufFn(
  body: ts.ConciseBody | ts.Block | undefined,
  sf: ts.SourceFile,
  typeParams: readonly ts.TypeParameterDeclaration[] | undefined,
): WrapperBinding | null {
  if (!body || !typeParams?.length) return null;
  const typeParamIndexes = new Map(typeParams.map((p, index) => [p.name.text, index]));
  const typeParamNames = typeParams.map(p => p.name.text);
  const bindings = collectProtobufImportBindings(sf);
  let found: WrapperBinding | null = null;

  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const cs = matchProtobufCallSite(node, sf, bindings, {
        allowLegacyUnboundCanonical: true,
      });
      if (
        cs &&
        ts.isTypeReferenceNode(cs.firstTypeArg) &&
        ts.isIdentifier(cs.firstTypeArg.typeName) &&
        typeParamIndexes.has(cs.firstTypeArg.typeName.text)
      ) {
        found = {
          fnName: cs.fnName,
          typeArgIndex: typeParamIndexes.get(cs.firstTypeArg.typeName.text)!,
          sourceFilePath: sf.fileName,
        };
        return;
      }

      if (cs && findTypeParameterIndex(cs.firstTypeArg, typeParamIndexes) !== null) {
        found = {
          fnName: cs.fnName,
          typeArgIndex: findTypeParameterIndex(cs.firstTypeArg, typeParamIndexes) ?? 0,
          typePattern: cs.firstTypeArg.getText(sf),
          typeParamNames,
          sourceFilePath: sf.fileName,
        };
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(body);
  return found;
}

function findTypeParameterIndex(typeNode: ts.TypeNode, typeParamIndexes: Map<string, number>): number | null {
  let index: number | null = null;
  function visit(node: ts.Node): void {
    if (index !== null) return;
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && typeParamIndexes.has(node.typeName.text)) {
      index = typeParamIndexes.get(node.typeName.text)!;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(typeNode);
  return index;
}

function matchForwardedKnownWrapper(
  body: ts.ConciseBody | ts.Block | undefined,
  typeParams: readonly ts.TypeParameterDeclaration[] | undefined,
  knownWrappers: Map<string, WrapperBinding>,
): WrapperBinding | null {
  if (!body || !typeParams?.length) return null;
  const tps = typeParams; // narrowed copy for closure scope
  const typeParamIndexes = new Map(tps.map((p, index) => [p.name.text, index]));
  let found: WrapperBinding | null = null;

  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node) && node.typeArguments?.length) {
      const callableName = getCallableName(node.expression);
      const wrapper = callableName ? knownWrappers.get(callableName) : undefined;
      const forwardedTypeArg = wrapper ? node.typeArguments[wrapper.typeArgIndex] : undefined;
      if (
        wrapper &&
        forwardedTypeArg &&
        ts.isTypeReferenceNode(forwardedTypeArg) &&
        ts.isIdentifier(forwardedTypeArg.typeName) &&
        !forwardedTypeArg.typeArguments?.length &&
        typeParamIndexes.has(forwardedTypeArg.typeName.text)
      ) {
        const chainTypeArgIndex = typeParamIndexes.get(forwardedTypeArg.typeName.text)!;
        const binding: WrapperBinding = {
          fnName: wrapper.fnName,
          typeArgIndex: chainTypeArgIndex,
        };
        // Propagate the typePattern from the inner wrapper, substituting
        // its type-param names with the chain's own. Otherwise the chain
        // would treat its own `<X>` as the encoded type rather than the
        // wrapped form (e.g. `Wrapper<X>`).
        if (wrapper.typePattern && wrapper.typeParamNames?.length === 1) {
          const chainParamName = tps[chainTypeArgIndex].name.text;
          const wrapperParamName = wrapper.typeParamNames[0];
          binding.typePattern = wrapperParamName === chainParamName
            ? wrapper.typePattern
            : wrapper.typePattern.replace(new RegExp(`\\b${wrapperParamName}\\b`, 'g'), chainParamName);
          binding.typeParamNames = [chainParamName];
          binding.sourceFilePath = wrapper.sourceFilePath;
        }
        found = binding;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(body);
  return found;
}

function collectWrapperCandidates(
  sf: ts.SourceFile,
  exportedOnly: boolean,
): Array<{ name: string; body: ts.ConciseBody | ts.Block | undefined; typeParameters: readonly ts.TypeParameterDeclaration[] | undefined }> {
  const candidates: Array<{ name: string; body: ts.ConciseBody | ts.Block | undefined; typeParameters: readonly ts.TypeParameterDeclaration[] | undefined }> = [];

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && (!exportedOnly || hasExportModifier(stmt))) {
      candidates.push({ name: stmt.name.text, body: stmt.body, typeParameters: stmt.typeParameters });
      continue;
    }

    if (!ts.isVariableStatement(stmt) || (exportedOnly && !hasExportModifier(stmt))) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const init = decl.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        candidates.push({ name: decl.name.text, body: init.body, typeParameters: init.typeParameters });
        continue;
      }

      if (ts.isObjectLiteralExpression(init)) {
        for (const prop of init.properties) {
          if (ts.isPropertyAssignment(prop)) {
            const propName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
            const propInit = prop.initializer;
            if (propName && (ts.isArrowFunction(propInit) || ts.isFunctionExpression(propInit))) {
              candidates.push({ name: propName, body: propInit.body, typeParameters: propInit.typeParameters });
            }
            continue;
          }

          if (ts.isMethodDeclaration(prop)) {
            const propName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
            if (propName) candidates.push({ name: propName, body: prop.body, typeParameters: prop.typeParameters });
          }
        }
      }
    }
  }

  return candidates;
}

function collectWrappers(
  sf: ts.SourceFile,
  exportedOnly: boolean,
  externalKnownWrappers: Map<string, WrapperBinding> = new Map(),
): Map<string, WrapperBinding> {
  const wrappers = new Map<string, WrapperBinding>();
  const localWrapperMembers = new Map<string, Map<string, WrapperBinding>>();
  const candidates = collectWrapperCandidates(sf, exportedOnly);

  for (const candidate of candidates) {
    const fn = matchForwardedProtobufFn(candidate.body, sf, candidate.typeParameters);
    if (fn) wrappers.set(candidate.name, fn);
  }

  // Detect both intra-file forwarders (`encodeFoo<T>(v) { return encodeBar<T>(v); }`
  // where `encodeBar` is local) AND cross-file forwarders to wrappers imported
  // from already-parsed modules. Externally known wrappers are seeded by the
  // caller (`parseFileForDefinitions`) after it resolves imports.
  const knownForForwarding = new Map<string, WrapperBinding>();
  for (const [k, v] of externalKnownWrappers) knownForForwarding.set(k, v);
  for (const [k, v] of wrappers) knownForForwarding.set(k, v);

  for (const candidate of candidates) {
    if (wrappers.has(candidate.name)) continue;
    const fn = matchForwardedKnownWrapper(candidate.body, candidate.typeParameters, knownForForwarding);
    if (fn) wrappers.set(candidate.name, fn);
  }

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt) || (exportedOnly && !hasExportModifier(stmt))) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const init = decl.initializer;
      if (ts.isObjectLiteralExpression(init)) {
        const memberWrappers = new Map<string, WrapperBinding>();
        for (const prop of init.properties) {
          if (!('name' in prop) || !prop.name) continue;
          const propName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
          if (!propName) continue;
          const fn = wrappers.get(propName);
          if (fn) {
            memberWrappers.set(propName, fn);
          }
        }
        if (memberWrappers.size) localWrapperMembers.set(decl.name.text, memberWrappers);
      }
    }
  }

  for (const stmt of sf.statements) {
    if (exportedOnly || !ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isPropertyAccessExpression(decl.initializer)) continue;
      if (!ts.isIdentifier(decl.initializer.expression)) continue;
      const memberWrappers = localWrapperMembers.get(decl.initializer.expression.text);
      const fn = memberWrappers?.get(decl.initializer.name.text);
      if (fn) wrappers.set(decl.name.text, fn);
    }
  }

  return wrappers;
}

/**
 * Parse a file and extract its protobuf interfaces and generic templates.
 *
 * When `cache` is provided, this resolves the file's imports recursively
 * (with cycle protection) so cross-file forwarded wrappers — e.g.
 * `export function encodeChain<T>(v) { return encodeBase<T>(v); }`
 * where `encodeBase` is imported from another module — can be detected.
 */
function parseFileForDefinitions(
  absolutePath: string,
  code?: string,
  cache?: Map<string, ParsedFileEntry>,
  parsing?: Set<string>,
): ParsedFileEntry {
  const sourceText = code ?? readFileSync(absolutePath, 'utf-8');
  const sf = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true);
  const concrete: ProtobufMessage[] = [];
  const templates = new Map<string, GenericProtobufTemplate>();
  const resolveImportedTypeName = createImportedTypeNameResolver(sf);
  const importedTypeSources = new Map<string, string>();
  const exportAllTypeSources = new Map<string, string>();
  const dependencyFiles = new Set<string>([absolutePath]);

  // Collect imported wrapper bindings (value imports only, not type-only)
  // so this file's forwarders can match against them.
  const importedKnownWrappers = new Map<string, WrapperBinding>();
  if (cache) {
    const inProgress = parsing ?? new Set<string>();
    inProgress.add(absolutePath);
    for (const imp of extractValueImports(sf)) {
      const resolved = resolveModulePath(imp.specifier, absolutePath);
      if (!resolved) continue;
      if (inProgress.has(resolved)) continue; // cycle guard
      let entry = cache.get(resolved);
      if (!entry) {
        entry = parseFileForDefinitions(resolved, undefined, cache, inProgress);
        cache.set(resolved, entry);
      }
      dependencyFiles.add(resolved);
      for (const dep of entry.dependencyFiles) dependencyFiles.add(dep);
      const wrapperFn = entry.exportedWrappers.get(imp.importedName);
      if (wrapperFn) importedKnownWrappers.set(imp.localName, wrapperFn);
    }
    inProgress.delete(absolutePath);
  }

  const exportedWrappers = collectWrappers(sf, true, importedKnownWrappers);

  for (const imp of extractImports(sf)) {
    const resolved = resolveModulePath(imp.specifier, absolutePath);
    if (!resolved) continue;
    importedTypeSources.set(imp.importedName, resolved);
    importedTypeSources.set(imp.localName, resolved);
  }

  if (cache) {
    const inProgress = parsing ?? new Set<string>();
    inProgress.add(absolutePath);
    for (const specifier of extractExportAllSpecifiers(sf)) {
      const resolved = resolveModulePath(specifier, absolutePath);
      if (!resolved || inProgress.has(resolved)) continue;
      let entry = cache.get(resolved);
      if (!entry) {
        entry = parseFileForDefinitions(resolved, undefined, cache, inProgress);
        cache.set(resolved, entry);
      }
      dependencyFiles.add(resolved);
      for (const dep of entry.dependencyFiles) dependencyFiles.add(dep);
      for (const msg of entry.concrete) exportAllTypeSources.set(msg.name, resolved);
      for (const name of entry.templates.keys()) exportAllTypeSources.set(name, resolved);
      for (const [name, source] of entry.exportAllTypeSources) exportAllTypeSources.set(name, source);
    }
    inProgress.delete(absolutePath);
  }

  for (const stmt of sf.statements) {
    if (!ts.isInterfaceDeclaration(stmt)) continue;
    if (stmt.typeParameters?.length) {
      const tpl = collectGenericInterface(stmt, sf, resolveImportedTypeName);
      if (tpl) templates.set(tpl.name, tpl);
    } else {
      const msg = collectInterface(stmt, sf, resolveImportedTypeName);
      if (msg) concrete.push(msg);
    }
  }

  return {
    filePath: absolutePath,
    sourceFile: sf,
    dependencyFiles: [...dependencyFiles],
    concrete,
    templates,
    importedTypeSources,
    exportAllTypeSources,
    resolveImportedTypeName,
    exportedWrappers,
  };
}

function collectCallRootTypeNodes(sf: ts.SourceFile): ts.TypeNode[] {
  const roots: ts.TypeNode[] = [];
  const importBindings = collectProtobufImportBindings(sf);

  ts.forEachChild(sf, function visit(node) {
    if (ts.isCallExpression(node)) {
      const cs = matchProtobufCallSite(node, sf, importBindings, {
        allowLegacyUnboundCanonical: true,
      });
      if (cs) roots.push(cs.firstTypeArg);
    }

    ts.forEachChild(node, visit);
  });

  return roots;
}

interface RootTypeNode {
  typeNode: ts.TypeNode;
  from: ParsedFileEntry;
}

/**
 * Resolve only the import definitions reachable from protobuf call-site roots.
 */
export function resolveImports(
  code: string,
  importerPath: string,
  cache: Map<string, ParsedFileEntry>,
): ImportedDefinitions {
  const entryPath = resolve(importerPath);
  const entry = parseFileForDefinitions(entryPath, code, cache);
  const concrete = new Map<string, ProtobufMessage>();
  const templates = new Map<string, GenericProtobufTemplate>();
  const fileEntries = new Map<string, ParsedFileEntry>([[entryPath, entry]]);
  const visitedConcrete = new Set<string>();
  const visitedTemplates = new Set<string>();
  const importedObjectWrapperMembers = new Map<string, Map<string, WrapperBinding>>();

  function getEntry(filePath: string): ParsedFileEntry {
    const abs = resolve(filePath);
    const known = fileEntries.get(abs);
    if (known) return known;

    let parsed = cache.get(abs);
    if (!parsed) {
      parsed = parseFileForDefinitions(abs, undefined, cache);
      cache.set(abs, parsed);
    }

    fileEntries.set(abs, parsed);
    return parsed;
  }

  function collectCalledGenericIdentifiers(sf: ts.SourceFile): Set<string> {
    const names = new Set<string>();

    ts.forEachChild(sf, function visit(node) {
      if (ts.isCallExpression(node) && node.typeArguments?.length) {
        const callableName = getCallableName(node.expression);
        if (callableName) names.add(callableName);
      }

      ts.forEachChild(node, visit);
    });

    return names;
  }

  function collectWrapperBindings(from: ParsedFileEntry, sf: ts.SourceFile): Map<string, WrapperBinding> {
    const bindings = new Map<string, WrapperBinding>();
    const localWrappers = from.filePath === entryPath ? collectWrappers(sf, false) : from.exportedWrappers;
    for (const [name, fn] of localWrappers) bindings.set(name, fn);

    const calledGenericIdentifiers = collectCalledGenericIdentifiers(sf);
    for (const imp of extractImports(sf)) {
      if (!calledGenericIdentifiers.has(imp.localName)) continue;
      const resolved = resolveModulePath(imp.specifier, from.filePath);
      if (!resolved) continue;
      const wrapperFn = getEntry(resolved).exportedWrappers.get(imp.importedName);
      if (wrapperFn) bindings.set(imp.localName, wrapperFn);

      const importedEntry = getEntry(resolved);
      const memberNames = [...importedEntry.exportedWrappers.keys()].filter(name => calledGenericIdentifiers.has(name));
      if (memberNames.length) {
        const members = new Map<string, WrapperBinding>();
        for (const name of memberNames) {
          const memberBinding = importedEntry.exportedWrappers.get(name)!;
          members.set(name, memberBinding);
          bindings.set(name, memberBinding);
        }
        importedObjectWrapperMembers.set(imp.localName, members);
      }
    }

    return bindings;
  }

  function resolveTypeName(typeName: string, from: ParsedFileEntry): void {
    if (typeName in PRIMITIVE_TYPE_MAP) return;

    const concreteMsg = from.concrete.find(msg => msg.name === typeName);
    if (concreteMsg) {
      const visitKey = `${from.filePath}:message:${typeName}`;
      if (visitedConcrete.has(visitKey)) return;
      visitedConcrete.add(visitKey);

      if (from.filePath !== entryPath && !concrete.has(concreteMsg.name)) {
        concrete.set(concreteMsg.name, concreteMsg);
      }

      for (const field of concreteMsg.fields) {
        resolveTypeName(field.typeName, from);
      }
      return;
    }

    const template = from.templates.get(typeName);
    if (template) {
      const visitKey = `${from.filePath}:template:${typeName}`;
      if (visitedTemplates.has(visitKey)) return;
      visitedTemplates.add(visitKey);

      if (from.filePath !== entryPath && !templates.has(template.name)) {
        templates.set(template.name, template);
      }

      for (const field of template.fields) {
        if (!field.isTypeParam) resolveTypeName(field.rawTypeName, from);
      }
      return;
    }

    const importedPath = from.importedTypeSources.get(typeName) ?? from.exportAllTypeSources.get(typeName);
    if (!importedPath) return;

    resolveTypeName(typeName, getEntry(importedPath));
  }

  function resolveTypeNode(typeNode: ts.TypeNode, from: ParsedFileEntry): void {
    if (isKeywordTypeNode(typeNode)) return;
    if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return;

    const typeName = from.resolveImportedTypeName(typeNode.typeName.text);
    resolveTypeName(typeName, from);

    if (!typeNode.typeArguments?.length) return;
    for (const typeArg of typeNode.typeArguments) {
      resolveTypeNode(typeArg, from);
    }
  }

  const entrySourceFile = entry.sourceFile;
  const rootTypeNodes: RootTypeNode[] = collectCallRootTypeNodes(entrySourceFile)
    .map(typeNode => ({ typeNode, from: entry }));
  const wrapperBindings = collectWrapperBindings(entry, entrySourceFile);

  ts.forEachChild(entrySourceFile, function visit(node) {
    if (ts.isCallExpression(node) && node.typeArguments?.length) {
      const callableName = getCallableName(node.expression);
      const binding = callableName ? wrapperBindings.get(callableName) ?? (
        ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
          ? importedObjectWrapperMembers.get(node.expression.expression.text)?.get(node.expression.name.text)
          : undefined
      ) : undefined;
      if (binding) {
        const typeArg = instantiateWrapperTypePattern(binding, node.typeArguments, entrySourceFile);
        if (typeArg) rootTypeNodes.push({
          typeNode: typeArg,
          from: binding.typePattern && binding.sourceFilePath ? getEntry(binding.sourceFilePath) : entry,
        });
        if (binding.typePattern) {
          for (const callerTypeArg of node.typeArguments) {
            rootTypeNodes.push({ typeNode: callerTypeArg, from: entry });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  });

  for (const root of rootTypeNodes) {
    resolveTypeNode(root.typeNode, root.from);
  }

  const dependencyFiles = new Set<string>(entry.dependencyFiles);
  for (const filePath of fileEntries.keys()) dependencyFiles.add(filePath);

  return {
    sourceFile: entrySourceFile,
    dependencyFiles: [...dependencyFiles],
    concrete: [...concrete.values()],
    templates,
    wrapperBindings,
  };
}
