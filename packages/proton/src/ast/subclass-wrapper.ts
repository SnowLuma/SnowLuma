import ts from 'typescript';
import { getPropertyNameText, isBareTypeRef, isStaticMethod } from './ast-helpers.js';
import { findImportSourcePath, type ParsedFileEntry } from './import-resolver.js';
import type { ClassWrapperInfo, WrapperCodecCall, WrapperMethodInfo } from './static-wrapper.js';
import { detectClassWrappers } from './static-wrapper.js';
import {
  createImportedTypeNameResolver,
  resolveSourceFileForTypeNode,
  typeNodeToMangledName,
} from './utils.js';

/**
 * AST-only subclass-wrapper resolution. For each wrapper inherited from an
 * abstract base, resolves the wrapper's type parameter to the concrete type
 * used by THIS subclass, so the override generator can emit a per-subclass
 * `Sub.method = function(...)` stub.
 *
 * Cross-file extends edges resolve through the import-resolver's `fileCache`
 * (the same cache populated by `resolveImports`), so no TypeChecker is needed.
 * Subclass methods MUST carry explicit type annotations — this resolver does
 * not infer types from method bodies.
 */

/** Where, in the wrapper's `this: T extends { … }` constraint, the
 *  codec-relevant type parameter is positioned on a member's signature. */
export type ResolutionPosition =
  | { kind: 'returnType' }
  | { kind: 'paramType'; index: number };

export interface ResolvedCodecCall extends WrapperCodecCall {
  resolvedTypeName: string;
  resolvedTypeNode: ts.TypeNode;
}

export interface ResolvedSubclassWrapper {
  /** The subclass declaration in the file being transformed. */
  subclass: ts.ClassDeclaration;
  wrapper: WrapperMethodInfo;
  /** Each codec call inside the wrapper body, with type parameters
   *  resolved against this specific subclass. */
  resolvedCodecCalls: ResolvedCodecCall[];
}

/** Wrapper detection memoised on the ClassDeclaration node. Module-level so a
 *  base class shared by many subclasses (or many transformed files) is only
 *  scanned once for the lifetime of the parsed entry in `fileCache`. The
 *  WeakMap drops entries automatically when HMR invalidates the parsed file. */
export class WrapperLookupCache {
  private readonly map = new WeakMap<ts.ClassDeclaration, ClassWrapperInfo | null>();

  getOrDetect(cls: ts.ClassDeclaration, sf: ts.SourceFile): ClassWrapperInfo | null {
    if (this.map.has(cls)) return this.map.get(cls)!;
    const info = detectClassWrappers(cls, sf);
    this.map.set(cls, info);
    return info;
  }
}

export const sharedWrapperCache = new WrapperLookupCache();

/** Cached `collectInheritedWrappers` results keyed by the subclass
 *  ClassDeclaration node. The set of wrappers inherited by a class is stable
 *  for the lifetime of its parsed entry; HMR drops the entry which drops the
 *  WeakMap binding automatically. */
const inheritanceCache = new WeakMap<ts.ClassDeclaration, WrapperMethodInfo[]>();

/** Walk the subclass's extends chain and return every wrapper inherited by it,
 *  paired with the per-codec-call type resolution. An empty array means the
 *  subclass either doesn't extend anything proton cares about, or proton
 *  couldn't resolve at least one type. */
export function resolveSubclassWrappers(
  subclass: ts.ClassDeclaration,
  subclassSf: ts.SourceFile,
  fileCache: Map<string, ParsedFileEntry>,
  wrapperCache: WrapperLookupCache,
): ResolvedSubclassWrapper[] {
  const results: ResolvedSubclassWrapper[] = [];
  const wrappers = collectInheritedWrappers(subclass, subclassSf, fileCache, wrapperCache);

  for (const wrapper of wrappers) {
    const resolvedCodecCalls = resolveWrapperCodecCalls(subclass, wrapper);
    if (resolvedCodecCalls === null) continue;
    results.push({ subclass, wrapper, resolvedCodecCalls });
  }

  return results;
}

function collectInheritedWrappers(
  cls: ts.ClassDeclaration,
  sf: ts.SourceFile,
  fileCache: Map<string, ParsedFileEntry>,
  wrapperCache: WrapperLookupCache,
): WrapperMethodInfo[] {
  const cached = inheritanceCache.get(cls);
  if (cached) return cached;

  const result: WrapperMethodInfo[] = [];
  // Skip `cls` itself: only override methods inherited from ancestors.
  let first = true;
  for (const node of walkExtendsChain(cls, sf, fileCache)) {
    if (first) { first = false; continue; }
    const info = wrapperCache.getOrDetect(node.cls, node.sf);
    if (!info) continue;
    for (const wrapper of info.values()) result.push(wrapper);
  }
  inheritanceCache.set(cls, result);
  return result;
}

/** Yield each level of the extends chain. Resolves cross-file edges by
 *  consulting the file's import statements + the shared `fileCache`. */
function* walkExtendsChain(
  cls: ts.ClassDeclaration,
  sf: ts.SourceFile,
  fileCache: Map<string, ParsedFileEntry>,
): IterableIterator<{ cls: ts.ClassDeclaration; sf: ts.SourceFile }> {
  let current: { cls: ts.ClassDeclaration; sf: ts.SourceFile } | null = { cls, sf };
  const seen = new Set<ts.ClassDeclaration>();
  while (current && !seen.has(current.cls)) {
    seen.add(current.cls);
    yield current;
    current = resolveExtendsParent(current.cls, current.sf, fileCache);
  }
}

function resolveExtendsParent(
  cls: ts.ClassDeclaration,
  sf: ts.SourceFile,
  fileCache: Map<string, ParsedFileEntry>,
): { cls: ts.ClassDeclaration; sf: ts.SourceFile } | null {
  const ext = cls.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
  const heritageExpr = ext?.types[0]?.expression;
  if (!heritageExpr || !ts.isIdentifier(heritageExpr)) return null;
  const baseName = heritageExpr.text;

  // Local declaration in the same file.
  const local = findClassByName(sf, baseName);
  if (local) return { cls: local, sf };

  // Imported from another module — look up the import specifier and find
  // the cached entry at that path.
  const sourcePath = findImportSourcePath(sf, baseName, sf.fileName);
  if (!sourcePath) return null;
  const entry = fileCache.get(sourcePath);
  if (!entry) return null;
  const parent = findClassByName(entry.sourceFile, baseName);
  if (!parent) return null;
  return { cls: parent, sf: entry.sourceFile };
}

function findClassByName(sf: ts.SourceFile, name: string): ts.ClassDeclaration | null {
  for (const stmt of sf.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === name) return stmt;
  }
  return null;
}

/** Resolve every codec call inside a wrapper body for one specific
 *  subclass. Returns null if any single codec call fails to resolve — the
 *  override is all-or-nothing because partially-generated code would
 *  reference undefined codec identifiers at runtime. */
function resolveWrapperCodecCalls(
  subclass: ts.ClassDeclaration,
  wrapper: WrapperMethodInfo,
): ResolvedCodecCall[] | null {
  if (!wrapper.thisConstraint) return null;

  const subclassSf = subclass.getSourceFile();
  const resolved: ResolvedCodecCall[] = [];
  for (const codecCall of wrapper.codecCalls) {
    const position = findTypeParamInConstraint(wrapper.thisConstraint, codecCall.typeParamName);
    if (!position) return null;

    const typeNode = extractSubclassMemberTypeNode(subclass, position.memberName, position.position);
    if (!typeNode) return null;

    const typeName = computeMangledName(typeNode, subclassSf);
    if (!typeName) return null;

    resolved.push({
      ...codecCall,
      resolvedTypeName: typeName,
      resolvedTypeNode: typeNode,
    });
  }
  return resolved;
}

interface ConstraintHit {
  memberName: string;
  position: ResolutionPosition;
}

/** Inspect a `{ memberName: (params) => returnType }` literal and locate
 *  the property whose signature references `typeParamName`. Returns the
 *  member name plus where on its signature the type appears. */
function findTypeParamInConstraint(constraint: ts.TypeNode, typeParamName: string): ConstraintHit | null {
  if (!ts.isTypeLiteralNode(constraint)) return null;

  for (const member of constraint.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const memberName = getPropertyNameText(member.name);
    if (!memberName) continue;
    const fnType = member.type;
    if (!ts.isFunctionTypeNode(fnType)) continue;

    if (fnType.type && isBareTypeRef(fnType.type, typeParamName)) {
      return { memberName, position: { kind: 'returnType' } };
    }
    for (let i = 0; i < fnType.parameters.length; i++) {
      const p = fnType.parameters[i];
      if (p.type && isBareTypeRef(p.type, typeParamName)) {
        return { memberName, position: { kind: 'paramType', index: i } };
      }
    }
  }
  return null;
}

/** Pull a type out of a subclass member's signature at the requested position.
 *  AST-only: the annotation must be explicit. Methods without annotations
 *  cannot be overridden by this pipeline (the wrapper instance is skipped). */
function extractSubclassMemberTypeNode(
  subclass: ts.ClassDeclaration,
  memberName: string,
  position: ResolutionPosition,
): ts.TypeNode | null {
  for (const member of subclass.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (!isStaticMethod(member)) continue;
    if (!ts.isIdentifier(member.name) || member.name.text !== memberName) continue;

    if (position.kind === 'returnType') return member.type ?? null;
    return member.parameters[position.index]?.type ?? null;
  }
  return null;
}

/** Map a resolved TypeNode to the mangled name proton's generator expects. */
function computeMangledName(node: ts.TypeNode, fallbackSf: ts.SourceFile): string | null {
  const effectiveSf = resolveSourceFileForTypeNode(node, fallbackSf);
  const resolver = createImportedTypeNameResolver(effectiveSf);
  try {
    return typeNodeToMangledName(node, effectiveSf, resolver);
  } catch {
    return null;
  }
}
