import ts from 'typescript';
import { getPropertyNameText, isBareTypeRef, isStaticMethod } from '../ast/ast-helpers.js';
import type { ClassWrapperInfo, WrapperCodecCall, WrapperMethodInfo } from '../ast/static-wrapper.js';
import { detectClassWrappers } from '../ast/static-wrapper.js';
import {
  createImportedTypeNameResolver,
  resolveSourceFileForTypeNode,
  typeNodeToMangledName,
} from '../ast/utils.js';

/**
 * Subclass-side resolution of inherited wrapper methods. For every wrapper
 * inherited from an abstract base, resolves the wrapper's type parameter to
 * the concrete type used by THIS subclass, so the override generator can
 * emit a per-subclass `Sub.method = function(...)` stub.
 *
 * Uses TypeChecker for cross-file extends-chain walking (with tsconfig path
 * aliases) and to infer types from method bodies that lack explicit annotations.
 */

/** Where, in the wrapper's `this: T extends { … }` constraint, the
 *  codec-relevant type parameter is positioned on a member's signature. */
export type ResolutionPosition =
  | { kind: 'returnType' }
  | { kind: 'paramType'; index: number };

export interface ResolvedCodecCall extends WrapperCodecCall {
  /** Mangled name of the resolved concrete type — same shape used by the
   *  rest of the analyzer (`UserMsg`, `Wrapper__string`, …). The override
   *  generator pastes `protobuf_encode_${typeName}` / `protobuf_decode_…`
   *  into the cloned wrapper body in place of the generic form. */
  resolvedTypeName: string;
  /** Synthetic TypeNode for the resolved type, suitable for handing to the
   *  monomorphizer. Lives in its own SourceFile via the existing synthetic-
   *  SF registry so subsequent `getText()` / import-resolution calls land
   *  in the right module. */
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

/** Walk a subclass's extends chain (via the checker) and return every
 *  wrapper inherited by it, paired with the per-codec-call type resolution.
 *  An empty array means the subclass either doesn't extend anything proton
 *  cares about, or proton couldn't resolve at least one type. */
export function resolveSubclassWrappers(
  subclass: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  wrapperCache: WrapperLookupCache,
): ResolvedSubclassWrapper[] {
  const results: ResolvedSubclassWrapper[] = [];
  const wrappers = collectInheritedWrappers(subclass, checker, wrapperCache);

  for (const wrapper of wrappers) {
    const resolvedCodecCalls = resolveWrapperCodecCalls(subclass, wrapper, checker);
    if (resolvedCodecCalls === null) continue;
    results.push({ subclass, wrapper, resolvedCodecCalls });
  }

  return results;
}

function collectInheritedWrappers(
  cls: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  wrapperCache: WrapperLookupCache,
): WrapperMethodInfo[] {
  const result: WrapperMethodInfo[] = [];
  // Skip `cls` itself: only override methods inherited from ancestors.
  let first = true;
  for (const ancestor of walkExtendsChain(cls, checker)) {
    if (first) { first = false; continue; }
    const info = wrapperCache.getOrDetect(ancestor);
    if (!info) continue;
    for (const wrapper of info.values()) result.push(wrapper);
  }
  return result;
}

/** Resolve every codec call inside a wrapper body for one specific
 *  subclass. Returns null if any single codec call fails to resolve — the
 *  override is all-or-nothing because partially-generated code would
 *  reference undefined codec identifiers at runtime. */
function resolveWrapperCodecCalls(
  subclass: ts.ClassDeclaration,
  wrapper: WrapperMethodInfo,
  checker: ts.TypeChecker,
): ResolvedCodecCall[] | null {
  if (!wrapper.thisConstraint) return null;

  const subclassSf = subclass.getSourceFile();
  const resolved: ResolvedCodecCall[] = [];
  for (const codecCall of wrapper.codecCalls) {
    const position = findTypeParamInConstraint(wrapper.thisConstraint, codecCall.typeParamName);
    if (!position) return null;

    const typeNode = extractSubclassMemberTypeNode(subclass, position.memberName, position.position, checker);
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

/** Inspect a `{ memberName: (params) => returnType }` literal and locate
 *  the property whose signature references `typeParamName`. Returns the
 *  member name plus where on its signature the type appears. */
interface ConstraintHit {
  memberName: string;
  position: ResolutionPosition;
}

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

/** Pull a type out of a subclass member's signature at the requested
 *  position. Prefers the explicit annotation when present; falls back to
 *  the TypeChecker's inferred type otherwise. */
function extractSubclassMemberTypeNode(
  subclass: ts.ClassDeclaration,
  memberName: string,
  position: ResolutionPosition,
  checker: ts.TypeChecker,
): ts.TypeNode | null {
  for (const member of subclass.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (!isStaticMethod(member)) continue;
    if (!ts.isIdentifier(member.name) || member.name.text !== memberName) continue;

    if (position.kind === 'returnType') {
      if (member.type) return member.type;
      const sig = checker.getSignatureFromDeclaration(member);
      if (!sig) return null;
      const ret = checker.getReturnTypeOfSignature(sig);
      return typeToTypeNode(ret, member, checker);
    }

    const param = member.parameters[position.index];
    if (!param) return null;
    if (param.type) return param.type;
    const type = checker.getTypeAtLocation(param);
    return typeToTypeNode(type, member, checker);
  }

  return null;
}

function typeToTypeNode(type: ts.Type, enclosing: ts.Node, checker: ts.TypeChecker): ts.TypeNode | null {
  return checker.typeToTypeNode(
    type,
    enclosing,
    ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseFullyQualifiedType,
  ) ?? null;
}

/** Walk the extends chain in source order, yielding the class declaration
 *  for each level. Uses the checker so cross-file edges and tsconfig path
 *  aliases resolve correctly. */
function* walkExtendsChain(
  cls: ts.ClassDeclaration,
  checker: ts.TypeChecker,
): IterableIterator<ts.ClassDeclaration> {
  let current: ts.ClassDeclaration | null = cls;
  const seen = new Set<ts.ClassDeclaration>();

  while (current && !seen.has(current)) {
    seen.add(current);
    yield current;

    const ext = current.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
    const heritageExpr = ext?.types[0]?.expression;
    if (!heritageExpr) break;

    const symbol = checker.getSymbolAtLocation(heritageExpr);
    if (!symbol) break;

    // When the parent is imported, `getSymbolAtLocation` lands on the
    // import-alias symbol; the class declaration lives on the aliased
    // target symbol. Resolve through the alias before reading
    // declarations — otherwise cross-file inheritance never finds the
    // base class.
    const targetSymbol = (symbol.flags & ts.SymbolFlags.Alias)
      ? checker.getAliasedSymbol(symbol)
      : symbol;

    const decls = targetSymbol.getDeclarations();
    if (!decls) break;
    const parentDecl = decls.find((d): d is ts.ClassDeclaration => ts.isClassDeclaration(d));
    if (!parentDecl) break;
    current = parentDecl;
  }
}

/** Map a resolved TypeNode to the mangled name proton's generator expects.
 *  Routes through `typeNodeToMangledName` so primitives, generics, and
 *  synthetic-SF-registered nodes all share the same shape used elsewhere
 *  in the analyzer. */
function computeMangledName(node: ts.TypeNode, fallbackSf: ts.SourceFile): string | null {
  // If the node was produced by TypeChecker (synthetic), the synthetic-SF
  // registry already has the right context; for explicit annotations the
  // node is part of the subclass's own SourceFile, which is what we hand
  // in as the fallback.
  const effectiveSf = resolveSourceFileForTypeNode(node, fallbackSf);
  const resolver = createImportedTypeNameResolver(effectiveSf);
  try {
    return typeNodeToMangledName(node, effectiveSf, resolver);
  } catch {
    return null;
  }
}

/**
 * Per-program cache of wrapper detection results. The same abstract base
 * gets re-discovered for every subclass it has, so memoizing on the class
 * declaration node keeps the cost flat as the number of subclasses grows.
 */
export class WrapperLookupCache {
  private readonly map = new WeakMap<ts.ClassDeclaration, ClassWrapperInfo | null>();

  getOrDetect(cls: ts.ClassDeclaration): ClassWrapperInfo | null {
    if (this.map.has(cls)) return this.map.get(cls)!;
    const sf = cls.getSourceFile();
    const info = detectClassWrappers(cls, sf);
    this.map.set(cls, info);
    return info;
  }
}
