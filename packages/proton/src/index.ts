import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import type { Plugin, ResolvedConfig } from 'vite';
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
import { invalidateProgramCache, prepareProgramForTsconfig } from './typecheck/program-cache.js';

export interface ProtobufVitePluginOptions {
  root?: string;
  tsconfig?: string;
  cache?: boolean | {
    dir?: string;
  };
}

interface ProtonPluginContext {
  viteRoot: string;
  scopeRoot: string;
  tsconfigPath: string;
  cacheEnabled: boolean;
  transformCacheDir: string;
  programCacheDir: string;
}

interface TransformDiskCacheEntry {
  version: number;
  sourceHash: string;
  configHash: string;
  dependencyMtims: Record<string, number>;
  result: { code: string; map: null } | null;
}

const TRANSFORM_CACHE_VERSION = 2;

export default function protobufVitePlugin(_options: ProtobufVitePluginOptions = {}): Plugin {
  const fileCache = new Map<string, ParsedFileEntry>();
  let ctx: ProtonPluginContext | null = null;

  return {
    name: 'vite-plugin-protobuf',
    enforce: 'pre',

    configResolved(config) {
      const nextCtx = createPluginContext(config, _options);
      ctx = nextCtx;
      if (nextCtx.cacheEnabled) {
        mkdirSync(nextCtx.transformCacheDir, { recursive: true });
        mkdirSync(nextCtx.programCacheDir, { recursive: true });
      }
      prepareProgramForTsconfig(nextCtx.tsconfigPath, {
        cacheDir: nextCtx.cacheEnabled ? nextCtx.programCacheDir : undefined,
      });
    },

    transform(code, id) {
      const cleanId = id.split('?')[0];
      if (!cleanId.endsWith('.ts') || cleanId.endsWith('.d.ts')) return null;
      const activeCtx = ctx ?? createStandaloneContext(_options);
      if (!isInScope(cleanId, activeCtx.scopeRoot)) return null;

      const sourceHash = hashString(code);
      const configHash = hashString(JSON.stringify({
        scopeRoot: normalizePath(activeCtx.scopeRoot),
        tsconfigPath: normalizePath(activeCtx.tsconfigPath),
        tsconfigMtime: safeMtime(activeCtx.tsconfigPath),
        version: TRANSFORM_CACHE_VERSION,
      }));
      const cachePath = activeCtx.cacheEnabled
        ? transformCachePath(activeCtx.transformCacheDir, cleanId)
        : null;
      const cached = cachePath ? readTransformCache(cachePath, sourceHash, configHash) : undefined;
      if (cached !== undefined) return cached;

      const imported = resolveImports(code, cleanId, fileCache);
      const { registry, callSites, sourceFile } = analyze(code, cleanId, imported);
      // Guard the TypeChecker-based wrapper pipeline behind a cheap scan:
      // most files have no extending classes.
      const subclassWrappers: SubclassWrapperPipelineResult = fileHasExtendingClass(sourceFile)
        ? runSubclassWrapperPipeline(cleanId)
        : { resolvedWrappers: [], extraRootTypeNames: [], insertions: [] };

      if (
        registry.size === 0 &&
        callSites.length === 0 &&
        subclassWrappers.resolvedWrappers.length === 0
      ) {
        if (cachePath) writeTransformCache(cachePath, sourceHash, configHash, imported.dependencyFiles, null);
        return null;
      }

      const used = selectUsedRegistry(
        registry,
        callSites,
        sourceFile,
        subclassWrappers.extraRootTypeNames,
      );
      if (used.registry.size === 0) {
        if (cachePath) writeTransformCache(cachePath, sourceHash, configHash, imported.dependencyFiles, null);
        return null;
      }

      const generatedCode = generateCode(used.registry);
      const replacementEdits = collectReplacementEdits(sourceFile, callSites, used.registry);
      const overrideEdits: TextEdit[] = subclassWrappers.insertions.map(i => ({
        start: i.position,
        end: i.position,
        replacement: i.code,
      }));
      const hasReplacements = replacementEdits.length > 0;
      const hasOverrides = overrideEdits.length > 0;
      if (!hasReplacements && generatedCode === '' && !hasOverrides) {
        if (cachePath) writeTransformCache(cachePath, sourceHash, configHash, imported.dependencyFiles, null);
        return null;
      }
      const transformedCode = applyTextEdits(code, [...replacementEdits, ...overrideEdits]);
      const result = {
        code: generatedCode + '\n' + transformedCode,
        map: null,
      };
      if (cachePath) writeTransformCache(cachePath, sourceHash, configHash, imported.dependencyFiles, result);

      return result;
    },

    handleHotUpdate({ file }) {
      if (file.endsWith('.ts')) {
        fileCache.delete(file);
        invalidateProgramCache(file);
      }
    },
  };
}

function buildContext(
  options: ProtobufVitePluginOptions,
  viteRoot: string,
  viteCacheDir: string,
  cacheEnabled: boolean,
): ProtonPluginContext {
  const scopeRoot = resolveOptionPath(options.root, viteRoot, viteRoot);
  const tsconfigPath = resolveOptionPath(options.tsconfig, viteRoot, resolve(scopeRoot, 'tsconfig.json'));
  const cacheBase = resolveCacheBase(options, viteRoot, viteCacheDir);
  return {
    viteRoot,
    scopeRoot,
    tsconfigPath,
    cacheEnabled,
    transformCacheDir: resolve(cacheBase, 'transform'),
    programCacheDir: resolve(cacheBase, 'program'),
  };
}

function createPluginContext(config: ResolvedConfig, options: ProtobufVitePluginOptions): ProtonPluginContext {
  return buildContext(options, resolve(config.root), config.cacheDir, options.cache !== false);
}

function createStandaloneContext(options: ProtobufVitePluginOptions): ProtonPluginContext {
  const viteRoot = process.cwd();
  return buildContext(options, viteRoot, resolve(viteRoot, 'node_modules', '.vite'), options.cache === true || typeof options.cache === 'object');
}

function resolveOptionPath(value: string | undefined, base: string, fallback: string): string {
  if (!value) return fallback;
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function resolveCacheBase(options: ProtobufVitePluginOptions, viteRoot: string, viteCacheDir: string): string {
  const configured = typeof options.cache === 'object' ? options.cache.dir : undefined;
  if (configured) return resolveOptionPath(configured, viteRoot, configured);
  return isAbsolute(viteCacheDir)
    ? resolve(viteCacheDir, 'proton')
    : resolve(viteRoot, viteCacheDir, 'proton');
}

function isInScope(filePath: string, scopeRoot: string): boolean {
  const file = normalizePath(filePath);
  const root = normalizePath(scopeRoot);
  return file === root || file.startsWith(root.endsWith('/') ? root : root + '/');
}

function transformCachePath(cacheDir: string, filePath: string): string {
  return resolve(cacheDir, `${hashString(normalizePath(filePath))}.json`);
}

function readTransformCache(
  cachePath: string,
  sourceHash: string,
  configHash: string,
): { code: string; map: null } | null | undefined {
  if (!existsSync(cachePath)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(cachePath, 'utf-8')) as TransformDiskCacheEntry;
    if (entry.version !== TRANSFORM_CACHE_VERSION) return undefined;
    if (entry.sourceHash !== sourceHash || entry.configHash !== configHash) return undefined;
    if (!dependencyMtimsMatch(entry.dependencyMtims)) return undefined;
    return entry.result;
  } catch {
    return undefined;
  }
}

function writeTransformCache(
  cachePath: string,
  sourceHash: string,
  configHash: string,
  dependencyFiles: readonly string[],
  result: { code: string; map: null } | null,
): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const entry: TransformDiskCacheEntry = {
      version: TRANSFORM_CACHE_VERSION,
      sourceHash,
      configHash,
      dependencyMtims: collectDependencyMtims(dependencyFiles),
      result,
    };
    writeFileSync(cachePath, JSON.stringify(entry));
  } catch {
    // Cache failures must never break the transform path.
  }
}

function collectDependencyMtims(files: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of files) {
    try {
      out[normalizePath(file)] = statSync(file).mtimeMs;
    } catch {
      out[normalizePath(file)] = -1;
    }
  }
  return out;
}

function dependencyMtimsMatch(mtims: Record<string, number>): boolean {
  for (const [file, previous] of Object.entries(mtims)) {
    if (safeMtime(file) !== previous) return false;
  }
  return true;
}

function safeMtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePath(value: string): string {
  return resolve(value).replace(/\\/g, '/');
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

