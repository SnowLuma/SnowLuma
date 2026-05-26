import ts from 'typescript';
import type { ResolvedSubclassWrapper } from '../typecheck/subclass-wrapper.js';

/**
 * Per-subclass override code generation. Copies the wrapper body verbatim,
 * rewrites every `protobuf_encode/decode<R>` to the concrete form, and emits:
 *
 * ```ts
 * Sub.encode = function (ctx, params) { … };
 * ```
 *
 * Output is TS-flavoured (not transpiled) — Vite handles the TS-to-JS pass.
 */

export interface SubclassOverrideRenderResult {
  /** The generated override source text, ready to append after the subclass
   *  declaration. Trailing newline included. */
  code: string;
}

export function renderSubclassOverride(resolved: ResolvedSubclassWrapper): SubclassOverrideRenderResult | null {
  const { subclass, wrapper, resolvedCodecCalls } = resolved;
  if (!subclass.name) return null;
  if (!wrapper.declaration.body) return null;
  if (resolvedCodecCalls.length === 0) return null;

  const wrapperSf = wrapper.declaration.getSourceFile();
  const body = wrapper.declaration.body;
  const bodyStart = body.getStart(wrapperSf);
  const bodyEnd = body.getEnd();
  const bodyText = wrapperSf.text.slice(bodyStart, bodyEnd);

  // Apply edits in reverse position order so earlier offsets stay valid.
  const edits = resolvedCodecCalls
    .map(c => ({
      start: c.exprStart - bodyStart,
      end: c.typeArgsEnd - bodyStart,
      replacement: `${c.fnName}_${c.resolvedTypeName}`,
    }))
    .filter(e => e.start >= 0 && e.end <= bodyText.length)
    .sort((a, b) => b.start - a.start);

  let body2 = bodyText;
  for (const e of edits) {
    body2 = body2.slice(0, e.start) + e.replacement + body2.slice(e.end);
  }

  const paramList = renderParameterList(wrapper.declaration, wrapperSf);
  const subclassName = subclass.name.text;
  const methodName = wrapper.methodName;

  return {
    code: `${subclassName}.${methodName} = function (${paramList}) ${body2};\n`,
  };
}

/** Build the parameter list for the override function. Skips the implicit
 *  `this` parameter (TypeScript-only; not real at runtime) and strips type
 *  annotations — the override is plain JS-flavoured TS at this point and
 *  carrying the original annotations would force the analyzer to also
 *  rewrite any type-references inside them, which is needless work for code
 *  that gets transpiled to JS in the very next pipeline step. */
function renderParameterList(method: ts.MethodDeclaration, sf: ts.SourceFile): string {
  const out: string[] = [];
  for (const param of method.parameters) {
    if (ts.isIdentifier(param.name) && param.name.text === 'this') continue;

    const namePart = renderBindingName(param.name, sf);
    const optional = param.questionToken ? '?' : '';
    const initializer = param.initializer
      ? ` = ${param.initializer.getText(sf)}`
      : '';
    const rest = param.dotDotDotToken ? '...' : '';

    out.push(`${rest}${namePart}${optional}${initializer}`);
  }
  return out.join(', ');
}

/** Stringify a parameter binding name, preserving destructuring patterns.
 *  We deliberately use `getText()` rather than re-emitting via the printer
 *  because the printer would also try to re-quote literals and re-format
 *  trivia, producing diffs against the user's original formatting that
 *  serve no purpose. */
function renderBindingName(name: ts.BindingName, sf: ts.SourceFile): string {
  return name.getText(sf);
}
