import ts from 'typescript';
import { getProgramForFile } from './program-cache.js';
import { resolveSubclassWrappers, WrapperLookupCache, type ResolvedSubclassWrapper } from './subclass-wrapper.js';
import { renderSubclassOverride } from '../codegen/subclass-override.js';

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
  /** Rendered override source text, in declaration order. Empty string
   *  when there's nothing to emit. */
  overrideCode: string;
}

export function runSubclassWrapperPipeline(filePath: string): SubclassWrapperPipelineResult {
  const empty: SubclassWrapperPipelineResult = {
    resolvedWrappers: [],
    extraRootTypeNames: [],
    overrideCode: '',
  };

  const programCtx = getProgramForFile(filePath);
  if (!programCtx) return empty;

  const sf = programCtx.program.getSourceFile(filePath);
  if (!sf) return empty;

  const cache = new WrapperLookupCache();
  const allResolved: ResolvedSubclassWrapper[] = [];
  const extraRoots = new Set<string>();

  for (const stmt of sf.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    const resolved = resolveSubclassWrappers(stmt, sf, programCtx.checker, cache);
    for (const r of resolved) {
      allResolved.push(r);
      for (const c of r.resolvedCodecCalls) extraRoots.add(c.resolvedTypeName);
    }
  }

  if (allResolved.length === 0) return empty;

  const overrideParts: string[] = [];
  for (const r of allResolved) {
    const rendered = renderSubclassOverride(r);
    if (rendered) overrideParts.push(rendered.code);
  }

  return {
    resolvedWrappers: allResolved,
    extraRootTypeNames: [...extraRoots],
    overrideCode: overrideParts.join(''),
  };
}
