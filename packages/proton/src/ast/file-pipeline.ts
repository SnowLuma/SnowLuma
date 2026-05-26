import { readFileSync } from 'fs';
import ts from 'typescript';
import { renderSubclassOverride } from '../codegen/subclass-override.js';
import { fileHasExtendingClass } from './ast-helpers.js';
import { resolveImports, type ParsedFileEntry } from './import-resolver.js';
import {
  resolveSubclassWrappers,
  sharedWrapperCache,
  type ResolvedSubclassWrapper,
} from './subclass-wrapper.js';

/** One contiguous insertion to splice into the user file, addressing the
 *  spot immediately after a subclass's closing `}`. Grouped per subclass so
 *  multiple inherited overrides (encode + decode + …) land together. */
export interface SubclassOverrideInsertion {
  /** Source-file offset of the insertion point. Always == subclass.end so
   *  any user code after the class declaration runs against the override. */
  position: number;
  /** Pre-rendered TS-flavoured snippet, ready to splice. */
  code: string;
}

/** Result returned by `runSubclassWrapperPipeline`. */
export interface SubclassWrapperPipelineResult {
  /** All resolved subclass overrides reachable from this file. Empty when
   *  no class in the file extends a wrapper-bearing base, or when resolution
   *  fails for every candidate. */
  resolvedWrappers: ResolvedSubclassWrapper[];
  /** Mangled type names that must be present in the codec registry for the
   *  generated overrides to compile against. Handed to `selectUsedRegistry`
   *  as extra roots. */
  extraRootTypeNames: string[];
  /** Pre-rendered insertions ready to feed into the text-edit applier. */
  insertions: SubclassOverrideInsertion[];
}

const EMPTY: SubclassWrapperPipelineResult = {
  resolvedWrappers: [],
  extraRootTypeNames: [],
  insertions: [],
};

/** Resolve inherited wrapper overrides for every class in `sourceFile` using
 *  the AST-only resolver. `fileCache` is the same map populated by
 *  `resolveImports`; cross-file extends edges are walked through it. */
export function runSubclassWrapperPipeline(
  sourceFile: ts.SourceFile,
  fileCache: Map<string, ParsedFileEntry>,
): SubclassWrapperPipelineResult {
  const allResolved: ResolvedSubclassWrapper[] = [];
  const extraRoots = new Set<string>();
  // Group per subclass so encode + decode + ... land in one contiguous block.
  const perSubclass = new Map<ts.ClassDeclaration, string[]>();

  for (const stmt of sourceFile.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    const resolved = resolveSubclassWrappers(stmt, sourceFile, fileCache, sharedWrapperCache);
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

  if (allResolved.length === 0) return EMPTY;

  const insertions: SubclassOverrideInsertion[] = [];
  for (const [subclass, codes] of perSubclass) {
    insertions.push({ position: subclass.end, code: '\n' + codes.join('\n') });
  }

  return {
    resolvedWrappers: allResolved,
    extraRootTypeNames: Array.from(extraRoots),
    insertions,
  };
}

/** Convenience entry that reads `filePath` from disk, builds a fresh file
 *  cache, and delegates to `runSubclassWrapperPipeline`. Used by tests and
 *  callers that don't already have a parsed source file + cache on hand. */
export function runSubclassWrapperPipelineFromPath(filePath: string): SubclassWrapperPipelineResult {
  let code: string;
  try {
    code = readFileSync(filePath, 'utf-8');
  } catch {
    return EMPTY;
  }
  // Cheap AST scan first — most files have no extending classes and we can
  // skip the expensive `resolveImports` recursive descent entirely.
  const probeSf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  if (!fileHasExtendingClass(probeSf)) return EMPTY;
  const fileCache = new Map<string, ParsedFileEntry>();
  const imported = resolveImports(code, filePath, fileCache);
  return runSubclassWrapperPipeline(imported.sourceFile, fileCache);
}
