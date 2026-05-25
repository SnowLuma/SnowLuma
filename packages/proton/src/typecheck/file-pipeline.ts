import ts from 'typescript';
import { renderSubclassOverride } from '../codegen/subclass-override.js';
import { getProgramForFile } from './program-cache.js';
import { resolveSubclassWrappers, WrapperLookupCache, type ResolvedSubclassWrapper } from './subclass-wrapper.js';

/** One contiguous insertion to splice into the user file, addressing the
 *  spot immediately after a subclass's closing `}`. Grouped per subclass so
 *  multiple inherited overrides (encode + decode + …) land together. */
export interface SubclassOverrideInsertion {
  /** Source-file offset of the insertion point. Always == subclass.end so
   *  any user code after the class declaration runs against the override. */
  position: number;
  /** Already-rendered override text. */
  code: string;
}

/**
 * Plugin-facing entry point for the subclass-wrapper feature.
 *
 * Pulls the file's TypeChecker (lazily — returns null and short-circuits
 * if no tsconfig is reachable), walks every class declaration in the
 * file's program-side SourceFile, runs the subclass resolver against each,
 * and returns both the resolved wrappers and the extra root type names
 * that the analyzer pipeline needs to drag into the codec registry.
 *
 * The function is intentionally side-effect free: caching of the Program
 * lives in `program-cache.ts`, and the override text is materialised by
 * `renderSubclassOverride`. Each call gets a fresh `WrapperLookupCache`
 * because the underlying detect call is memoised per ClassDeclaration —
 * the cache only matters across the iterations of a single file's
 * subclasses (which is exactly what we do here).
 */
export interface SubclassWrapperPipelineResult {
  /** All resolved subclass overrides reachable from this file. Empty when
   *  TypeChecker is unavailable, when no class in the file extends a
   *  wrapper-bearing base, or when resolution fails for every candidate. */
  resolvedWrappers: ResolvedSubclassWrapper[];
  /** Mangled type names that must be present in the codec registry for the
   *  generated overrides to compile against. Handed to `selectUsedRegistry`
   *  as extra roots. */
  extraRootTypeNames: string[];
  /** Per-subclass insertion points + rendered override text. Inserted into
   *  the user's source immediately after the subclass declaration so any
   *  subsequent statements (including top-level `Sub.method(...)` calls)
   *  see the override and dispatch through it, not the inherited body. */
  insertions: SubclassOverrideInsertion[];
}

/** Splice each rendered override into `code` at its captured position.
 *  Insertions are sorted in reverse so earlier offsets stay valid as we
 *  apply later edits — same pattern the replacer uses for codec call-site
 *  rewriting. Returns `code` unchanged when there's nothing to insert. */
export function applyOverrideInsertions(code: string, insertions: SubclassOverrideInsertion[]): string {
  if (insertions.length === 0) return code;
  const sorted = [...insertions].sort((a, b) => b.position - a.position);
  let out = code;
  for (const ins of sorted) {
    out = out.slice(0, ins.position) + ins.code + out.slice(ins.position);
  }
  return out;
}

export function runSubclassWrapperPipeline(filePath: string): SubclassWrapperPipelineResult {
  const empty: SubclassWrapperPipelineResult = {
    resolvedWrappers: [],
    extraRootTypeNames: [],
    insertions: [],
  };

  const programCtx = getProgramForFile(filePath);
  if (!programCtx) return empty;

  const sf = programCtx.program.getSourceFile(filePath);
  if (!sf) return empty;

  const cache = new WrapperLookupCache();
  const allResolved: ResolvedSubclassWrapper[] = [];
  const extraRoots = new Set<string>();
  // Group rendered overrides per subclass so encode + decode + ... for the
  // same class land in one contiguous block right after the class body.
  // Otherwise the plugin would have to apply multiple identical-position
  // edits and worry about ordering.
  const perSubclass = new Map<ts.ClassDeclaration, string[]>();

  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    const resolved = resolveSubclassWrappers(stmt, sf, programCtx.checker, cache);
    for (const r of resolved) {
      allResolved.push(r);
      for (const c of r.resolvedCodecCalls) extraRoots.add(c.resolvedTypeName);

      const rendered = renderSubclassOverride(r);
      if (!rendered) continue;
      const bucket = perSubclass.get(r.subclass);
      if (bucket) bucket.push(rendered.code);
      else perSubclass.set(r.subclass, [rendered.code]);
    }
  }

  if (allResolved.length === 0) return empty;

  const insertions: SubclassOverrideInsertion[] = [];
  for (const [cls, parts] of perSubclass) {
    insertions.push({
      position: cls.getEnd(),
      code: '\n' + parts.join(''),
    });
  }

  return {
    resolvedWrappers: allResolved,
    extraRootTypeNames: [...extraRoots],
    insertions,
  };
}
