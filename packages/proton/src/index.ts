import type { Plugin } from 'vite';
import { analyze, analyzeSource, selectUsedRegistry, typeNodeToMangledName } from './ast/analyzer.js';
import { generateCode } from './codegen/generator.js';
import { applyReplacements, replaceCallSites } from './transform/replacer.js';
import type { MessageRegistry } from './ast/types.js';
import { resolveImports, type ParsedFileEntry } from './ast/import-resolver.js';
import { createRuntimeMap, type RuntimeMapCallSite } from './runtime-map.js';

export interface ProtobufRuntimeMapPluginOptions {
  enabled?: boolean;
  fileName?: string;
}

export interface ProtobufVitePluginOptions {
  runtimeMap?: ProtobufRuntimeMapPluginOptions;
}

interface RuntimeMapFileEntry {
  messages: MessageRegistry;
  callSites: RuntimeMapCallSite[];
}

export default function protobufVitePlugin(options: ProtobufVitePluginOptions = {}): Plugin {
  const fileCache = new Map<string, ParsedFileEntry>();
  const runtimeMapByFile = new Map<string, RuntimeMapFileEntry>();
  const runtimeMapEnabled = options.runtimeMap?.enabled === true;
  const runtimeMapFileName = options.runtimeMap?.fileName ?? 'snowluma-proton.runtime-map.json';

  return {
    name: 'vite-plugin-protobuf',
    enforce: 'pre',

    transform(code, id) {
      const cleanId = id.split('?')[0];
      if (!cleanId.endsWith('.ts') || cleanId.endsWith('.d.ts')) return null;

      const imported = resolveImports(code, cleanId, fileCache);
      const { registry, callSites, sourceFile } = analyze(code, cleanId, imported);
      if (registry.size === 0 && callSites.length === 0) return null;

      const used = selectUsedRegistry(registry, callSites, sourceFile);
      if (used.registry.size === 0) {
        runtimeMapByFile.delete(cleanId);
        return null;
      }

      if (runtimeMapEnabled) {
        runtimeMapByFile.set(cleanId, {
          messages: used.registry,
          callSites: used.callSites.map(cs => ({
            file: cleanId,
            line: cs.line,
            column: cs.column,
            fnName: cs.fnName as RuntimeMapCallSite['fnName'],
            typeName: cs.typeName,
          })),
        });
      }

      const generatedCode = generateCode(used.registry);
      const { transformedCode, hasReplacements } = applyReplacements(code, sourceFile, callSites, used.registry);
      if (!hasReplacements && generatedCode === '') return null;

      return { code: generatedCode + '\n' + transformedCode, map: null };
    },

    handleHotUpdate({ file }) {
      if (file.endsWith('.ts')) {
        fileCache.delete(file);
        runtimeMapByFile.delete(file);
      }
    },

    generateBundle() {
      if (!runtimeMapEnabled) return;

      const mergedMessages: MessageRegistry = new Map();
      const mergedCallSites: RuntimeMapCallSite[] = [];

      for (const entry of runtimeMapByFile.values()) {
        for (const [name, msg] of entry.messages) mergedMessages.set(name, msg);
        mergedCallSites.push(...entry.callSites);
      }

      if (mergedMessages.size === 0 || mergedCallSites.length === 0) return;

      const runtimeMap = createRuntimeMap({
        messages: mergedMessages,
        callSites: mergedCallSites,
      });

      this.emitFile({
        type: 'asset',
        fileName: runtimeMapFileName,
        source: JSON.stringify(runtimeMap, null, 2),
      });
    },
  };
}

export {
  analyze,
  analyzeSource,
  generateCode,
  replaceCallSites,
  applyReplacements,
  typeNodeToMangledName,
  resolveImports,
  selectUsedRegistry,
  createRuntimeMap,
};

export type { ProtobufRuntimeMap, RuntimeMapCallSite } from './runtime-map.js';
