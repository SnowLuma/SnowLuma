import ts from 'typescript';
import type { CallSiteRecord } from '../ast/analyzer.js';
import { collectProtobufImportBindings, matchProtobufCallSite } from '../ast/callsite.js';
import type { MessageRegistry } from '../ast/types.js';
import { createImportedTypeNameResolver, typeNodeToMangledName } from '../ast/utils.js';
import { applyTextEdits, type TextEdit } from './text-edits.js';

export function collectReplacementEdits(
  sf: ts.SourceFile,
  callSites: CallSiteRecord[],
  registry: MessageRegistry,
): TextEdit[] {
  const edits: TextEdit[] = [];
  const resolveImportedTypeName = createImportedTypeNameResolver(sf);

  for (const cs of callSites) {
    const mangled = typeNodeToMangledName(cs.firstTypeArg, sf, resolveImportedTypeName);
    if (!registry.has(mangled)) continue;
    edits.push({
      start: cs.exprStart,
      end: cs.typeArgsEnd,
      replacement: `${cs.fnName}_${mangled}`,
    });
  }

  return edits;
}

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
  const edits = collectReplacementEdits(sf, callSites, registry);
  if (!edits.length) return { transformedCode: code, hasReplacements: false };
  return { transformedCode: applyTextEdits(code, edits), hasReplacements: true };
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
