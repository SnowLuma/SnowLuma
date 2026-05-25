import type { Plugin } from 'vite';
import { analyze, analyzeSource, selectUsedRegistry, typeNodeToMangledName } from './ast/analyzer.js';
import { fileHasExtendingClass } from './ast/ast-helpers.js';
import { resolveImports, type ParsedFileEntry } from './ast/import-resolver.js';
import { generateCode } from './codegen/generator.js';
import { applyReplacements, replaceCallSites } from './transform/replacer.js';
import {
  applyOverrideInsertions,
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
      const { transformedCode, hasReplacements } = applyReplacements(code, sourceFile, callSites, used.registry);
      // Splice per-subclass overrides immediately after each subclass
      // declaration so any user-side `Sub.method(...)` call later in the
      // file sees the override on the constructor, not the inherited
      // abstract body that would erase R/B at runtime.
      const codeWithOverrides = applyOverrideInsertions(transformedCode, subclassWrappers.insertions);
      const hasOverrides = codeWithOverrides !== transformedCode;
      if (!hasReplacements && generatedCode === '' && !hasOverrides) return null;

      return {
        code: generatedCode + '\n' + codeWithOverrides,
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

