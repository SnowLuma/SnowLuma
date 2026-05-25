import ts from 'typescript';
import { getMethodName, isStaticMethod } from './ast-helpers.js';
import { collectProtobufImportBindings, matchProtobufCallSite, type CanonicalProtobufFn, type ProtobufImportBindings } from './callsite.js';

/**
 * Static-method wrapper detection.
 *
 * A "wrapper" here is the abstract half of the pattern that motivates the
 * whole feature:
 *
 * ```ts
 * abstract class PacketTransformer {
 *   static encode<R, T extends { serialize: (...) => R }>(this: T, ...) {
 *     return protobuf_encode<R>(this.serialize(...));
 *   }
 * }
 * ```
 *
 * The method itself can never run at the user's call site because `R` is
 * erased at runtime. Proton's job is to walk every subclass of such a base,
 * resolve `R` per subclass via TypeChecker, and emit a per-subclass override
 * with a concrete codec inlined.
 *
 * This module only handles the AST-side detection — what the method looks
 * like and which type parameter it pipes into protobuf_encode/decode. The
 * subclass resolution + codegen lives in `typecheck/subclass-wrapper.ts`
 * because both steps need a TypeChecker.
 *
 * The detector is intentionally name-agnostic: it doesn't care that the
 * method is called `encode`, that the sibling is `serialize`, or that the
 * base is `PacketTransformer`. It only looks at the structural pattern,
 * which keeps it usable for user-defined variants (decode side, RPC chains,
 * etc.) without further configuration.
 */

/** A single `protobuf_encode<X>(...)` / `protobuf_decode<X>(...)` call inside
 *  the wrapper's body where `X` is one of the wrapper's own type parameters.
 *  The override generator uses the position info to splice in a concrete
 *  codec identifier in place of the generic form. */
export interface WrapperCodecCall {
  fnName: CanonicalProtobufFn;
  /** Name of the wrapper's type parameter used as the type argument. Always
   *  one of `WrapperMethodInfo.typeParamNames`. */
  typeParamName: string;
  /** Offset of the call's expression start (e.g. `protobuf_encode`) in the
   *  *original* source file. */
  exprStart: number;
  /** Offset directly after the closing `>` of the type-argument list. */
  typeArgsEnd: number;
}

export interface WrapperMethodInfo {
  /** Method name as written on the abstract class — used to look up
   *  override targets on subclasses. */
  methodName: string;
  /** All type parameters declared by this method (`<R, T, ...>`). */
  typeParamNames: string[];
  /** Constraint sub-AST attached to the `this: T` parameter, if any.
   *  The subclass resolver uses this to figure out which sibling method's
   *  signature defines each codec-relevant type parameter. */
  thisConstraint: ts.TypeNode | null;
  /** Original method declaration node — kept so the override generator can
   *  copy its parameter list and body verbatim before substituting codecs. */
  declaration: ts.MethodDeclaration;
  /** Every protobuf_encode/decode call inside the body whose type-arg is
   *  one of the wrapper's type parameters. There can legitimately be
   *  several (encode + decode sharing a body, sequential pipeline, etc.). */
  codecCalls: WrapperCodecCall[];
}

export interface ClassWrapperInfo {
  /** The abstract class declaration carrying the wrapper methods. */
  classDecl: ts.ClassDeclaration;
  /** Map keyed by method name for O(1) lookup during override generation. */
  methods: Map<string, WrapperMethodInfo>;
}

/** Find every static-method wrapper on a single class. Returns null if the
 *  class has no qualifying methods (the common case — only the abstract
 *  base of a transformer hierarchy will return non-null). */
export function detectClassWrappers(
  cls: ts.ClassDeclaration,
  sf: ts.SourceFile,
  bindings?: ProtobufImportBindings,
): ClassWrapperInfo | null {
  const importBindings = bindings ?? collectProtobufImportBindings(sf);
  const methods = new Map<string, WrapperMethodInfo>();

  for (const member of cls.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (!isStaticMethod(member)) continue;
    if (!member.typeParameters?.length) continue;
    if (!member.body) continue;
    const methodName = getMethodName(member);
    if (!methodName) continue;

    const typeParamNames = member.typeParameters.map(tp => tp.name.text);
    const typeParamSet = new Set(typeParamNames);
    const codecCalls = collectCodecCallsInBody(member.body, sf, importBindings, typeParamSet);
    if (codecCalls.length === 0) continue;

    methods.set(methodName, {
      methodName,
      typeParamNames,
      thisConstraint: extractThisConstraint(member),
      declaration: member,
      codecCalls,
    });
  }

  if (methods.size === 0) return null;
  return { classDecl: cls, methods };
}

/** Locate every wrapper-bearing class in a single source file. Driven from
 *  the analyzer once per file; the subclass resolver consumes the result. */
export function detectClassWrappersInFile(
  sf: ts.SourceFile,
  bindings?: ProtobufImportBindings,
): Map<string, ClassWrapperInfo> {
  const importBindings = bindings ?? collectProtobufImportBindings(sf);
  const out = new Map<string, ClassWrapperInfo>();
  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    const info = detectClassWrappers(stmt, sf, importBindings);
    if (info) out.set(stmt.name.text, info);
  }
  return out;
}

/** Walk method body, collecting every protobuf_encode/decode call whose
 *  type-arg is a bare reference to one of the method's type parameters. */
function collectCodecCallsInBody(
  body: ts.Block,
  sf: ts.SourceFile,
  importBindings: ProtobufImportBindings,
  typeParamSet: Set<string>,
): WrapperCodecCall[] {
  const out: WrapperCodecCall[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const cs = matchProtobufCallSite(node, sf, importBindings, { allowLegacyUnboundCanonical: true });
      if (cs) {
        const ta = cs.firstTypeArg;
        // Only track calls whose type-arg is a simple type-param identifier.
        // `protobuf_encode<Wrapper<T>>` etc. is rare in wrapper bodies; if it
        // shows up we'd need a more elaborate substitution scheme so we leave
        // it for now (the AST analyzer's existing path handles concrete
        // forms separately).
        if (ts.isTypeReferenceNode(ta) && ts.isIdentifier(ta.typeName) && !ta.typeArguments?.length) {
          const name = ta.typeName.text;
          if (typeParamSet.has(name)) {
            out.push({
              fnName: cs.fnName,
              typeParamName: name,
              exprStart: cs.exprStart,
              typeArgsEnd: cs.typeArgsEnd,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(body);
  return out;
}

/** Pluck the `T` constraint from a `this: T` parameter, returning the
 *  constraint TypeNode (e.g. the `{ serialize: ... }` literal). Returns
 *  null for any shape that doesn't match — the subclass resolver treats
 *  that as "no per-subclass override possible". */
function extractThisConstraint(method: ts.MethodDeclaration): ts.TypeNode | null {
  const thisParam = method.parameters.find(p =>
    ts.isIdentifier(p.name) && p.name.text === 'this',
  );
  if (!thisParam?.type) return null;
  if (!ts.isTypeReferenceNode(thisParam.type) || !ts.isIdentifier(thisParam.type.typeName)) return null;
  const thisTypeParamName = thisParam.type.typeName.text;

  const thisTypeParam = method.typeParameters?.find(tp => tp.name.text === thisTypeParamName);
  return thisTypeParam?.constraint ?? null;
}
