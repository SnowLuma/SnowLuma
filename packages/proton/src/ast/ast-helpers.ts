import ts from 'typescript';

/**
 * Tiny AST predicates shared across the analyzer, callsite matcher,
 * wrapper detector, and subclass resolver.
 *
 * All of these are pure structural checks on individual nodes — they
 * don't walk children, don't read file content, and don't touch the
 * TypeChecker. Collecting them in one module avoids the four+ private
 * re-definitions that accreted while the feature stack grew.
 */

/** Identifier text behind a call's callee, normalising `foo(...)` and
 *  `obj.foo(...)` to just `foo`. Returns null for any other shape
 *  (element access, parenthesised expression, etc.) so callers don't
 *  accidentally treat dynamic dispatch as a known identifier. */
export function getCallableName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

export function isStaticMethod(m: ts.MethodDeclaration): boolean {
  const mods = ts.getModifiers(m);
  return mods?.some(mod => mod.kind === ts.SyntaxKind.StaticKeyword) ?? false;
}

export function getMethodName(m: ts.MethodDeclaration): string | null {
  if (ts.isIdentifier(m.name)) return m.name.text;
  if (ts.isStringLiteral(m.name)) return m.name.text;
  return null;
}

export function getPropertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

/** Match a `TypeNode` that's just a bare reference to `name` with no
 *  type-args (`Foo`, NOT `Foo<X>` and NOT `ns.Foo`). Used by the
 *  subclass resolver when looking for a method's type parameter inside
 *  a `this: T extends {…}` constraint. */
export function isBareTypeRef(node: ts.TypeNode, name: string): boolean {
  if (!ts.isTypeReferenceNode(node)) return false;
  if (!ts.isIdentifier(node.typeName)) return false;
  return node.typeName.text === name;
}

/** True if the file has at least one top-level class declaration whose
 *  heritage clause includes `extends X`. Cheap O(top-level) scan used
 *  as a precondition guard before doing TypeChecker-heavy work — most
 *  files in a typical project have no extending classes and this lets
 *  us short-circuit the whole subclass-wrapper pipeline. */
export function fileHasExtendingClass(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt)) continue;
    if (!stmt.heritageClauses?.length) continue;
    for (const h of stmt.heritageClauses) {
      if (h.token === ts.SyntaxKind.ExtendsKeyword && h.types.length > 0) return true;
    }
  }
  return false;
}
