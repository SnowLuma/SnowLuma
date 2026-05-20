import type { MessageRegistry } from '../ast/types.js';
import type { CallSiteRecord } from '../ast/analyzer.js';
import { createImportedTypeNameResolver, typeNodeToMangledName } from '../ast/utils.js';
import { collectProtobufImportBindings, matchProtobufCallSite } from '../ast/callsite.js';
import ts from 'typescript';

interface TextEdit { start: number; end: number; replacement: string }

/**
 * Apply replacements using pre-recorded call-sites from analyze().
 * No parsing or AST walking — just position-based string edits.
 */
export function applyReplacements(
  code: string,
  sf: ts.SourceFile,
  callSites: CallSiteRecord[],
  registry: MessageRegistry,
): { transformedCode: string; hasReplacements: boolean } {
  const edits: TextEdit[] = [];
  const resolveImportedTypeName = createImportedTypeNameResolver(sf);

  for (const cs of callSites) {
    const mangled = typeNodeToMangledName(cs.firstTypeArg, sf, resolveImportedTypeName);
    if (registry.has(mangled)) {
      edits.push({
        start: cs.exprStart,
        end: cs.typeArgsEnd,
        replacement: `${cs.fnName}_${mangled}`,
      });
    }
  }

  if (!edits.length) return { transformedCode: code, hasReplacements: false };

  edits.sort((a, b) => b.start - a.start);
  let result = code;
  for (const ed of edits) result = result.slice(0, ed.start) + ed.replacement + result.slice(ed.end);
  return { transformedCode: result, hasReplacements: true };
}

/**
 * Backward-compatible: parses + walks on its own.
 * Prefer applyReplacements() with pre-recorded call-sites from analyze().
 */
export function replaceCallSites(code: string, registry: MessageRegistry): { transformedCode: string; hasReplacements: boolean } {
  const sf = ts.createSourceFile('input.ts', code, ts.ScriptTarget.Latest, true);
  const callSites: CallSiteRecord[] = [];
  const importBindings = collectProtobufImportBindings(sf);

  ts.forEachChild(sf, function visit(node) {
    if (ts.isCallExpression(node)) {
      const cs = matchProtobufCallSite(node, sf, importBindings, {
        allowLegacyUnboundCanonical: true,
      });
      if (cs) callSites.push(cs);
    }
    ts.forEachChild(node, visit);
  });

  return applyReplacements(code, sf, callSites, registry);
}
