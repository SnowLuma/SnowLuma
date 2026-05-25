import type { Plugin } from 'vite';
import { analyze, analyzeSource, selectUsedRegistry, typeNodeToMangledName } from './ast/analyzer.js';
import { fileHasExtendingClass } from './ast/ast-helpers.js';
import { resolveImports, type ParsedFileEntry } from './ast/import-resolver.js';
import { generateCode } from './codegen/generator.js';
import { applyReplacements, collectReplacementEdits, replaceCallSites } from './transform/replacer.js';
import { applyTextEdits, type TextEdit } from './transform/text-edits.js';
import {
  runSubclassWrapperPipeline,
  type SubclassWrapperPipelineResult,
} from './typecheck/file-pipeline.js';
import { invalidateProgramCache } from './typecheck/program-cache.js';

export type ProtobufVitePluginOptions = Record<string, never>;

export default function protobufVitePlugin(_options: ProtobufVitePluginOptions = {}): Plugin {
  const fileCache = new Map<string, ParsedFileEntry>();

  return {
    name: 'vite-plugin-protobuf',
    enforce: 'pre',

    transform(code, id) {
      const cleanId = id.split('?')[0];
      if (!cleanId.endsWith('.ts') || cleanId.endsWith('.d.ts')) return null;

      const imported = resolveImports(code, cleanId, fileCache);
      const { registry, callSites, sourceFile } = analyze(code, cleanId, imported);
      // The subclass-wrapper pipeline needs a TypeChecker, which carries a
      // 1–2 second startup cost the first time we touch a tsconfig.
      // Almost every file in a typical project has zero extending classes,
      // so guard the heavy work behind a cheap top-level scan and only
      // build the Program when there's actually a candidate to resolve.
      const subclassWrappers: SubclassWrapperPipelineResult = fileHasExtendingClass(sourceFile)
        ? runSubclassWrapperPipeline(cleanId)
        : { resolvedWrappers: [], extraRootTypeNames: [], insertions: [] };

      if (
        registry.size === 0 &&
        callSites.length === 0 &&
        subclassWrappers.resolvedWrappers.length === 0
      ) {
        return null;
      }

      const used = selectUsedRegistry(
        registry,
        callSites,
        sourceFile,
        subclassWrappers.extraRootTypeNames,
      );
      if (used.registry.size === 0) return null;

      const generatedCode = generateCode(used.registry);
      const replacementEdits = collectReplacementEdits(sourceFile, callSites, used.registry);
      const overrideEdits: TextEdit[] = subclassWrappers.insertions.map(i => ({
        start: i.position,
        end: i.position,
        replacement: i.code,
      }));
      const hasReplacements = replacementEdits.length > 0;
      const hasOverrides = overrideEdits.length > 0;
      if (!hasReplacements && generatedCode === '' && !hasOverrides) return null;
      const transformedCode = applyTextEdits(code, [...replacementEdits, ...overrideEdits]);

      return {
        code: generatedCode + '\n' + transformedCode,
        map: null,
      };
    },

    handleHotUpdate({ file }) {
      if (file.endsWith('.ts')) {
        fileCache.delete(file);
        invalidateProgramCache(file);
      }
    },
  };
}

export {
  analyze,
  analyzeSource,
  applyReplacements,
  generateCode,
  replaceCallSites,
  resolveImports,
  selectUsedRegistry,
  typeNodeToMangledName
};

