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

/** Result returned by `runSubclassWrapperPipeline`. */
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

/** Lazily retrieves the TypeChecker (returns empty result when no tsconfig is
 *  reachable), resolves inherited wrapper overrides for every class in the file,
 *  and returns resolved wrappers, extra codec roots, and insertion points. */
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
  // Group per subclass so encode + decode + ... land in one contiguous block.
  const perSubclass = new Map<ts.ClassDeclaration, string[]>();

  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    const resolved = resolveSubclassWrappers(stmt, programCtx.checker, cache);
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
