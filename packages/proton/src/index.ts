import type { Plugin } from 'vite';
import { analyze, analyzeSource, selectUsedRegistry, typeNodeToMangledName } from './ast/analyzer.js';
import { resolveImports, type ParsedFileEntry } from './ast/import-resolver.js';
import { generateCode } from './codegen/generator.js';
import { applyReplacements, replaceCallSites } from './transform/replacer.js';
import { applyOverrideInsertions, runSubclassWrapperPipeline } from './typecheck/file-pipeline.js';
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
      // Subclass-wrapper pipeline lives outside the AST analyzer because it
      // needs a TypeChecker. It returns extra root type names that must
      // participate in `selectUsedRegistry` so the codecs they reference
      // actually get generated, plus the per-subclass override text we
      // append after the user code.
      const subclassWrappers = runSubclassWrapperPipeline(cleanId);

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

