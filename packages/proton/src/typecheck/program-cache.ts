import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import ts from 'typescript';

/**
 * Lazy ts.Program cache keyed by tsconfig path. Built once per tsconfig and
 * reused across transform calls; HMR drops the cache for the affected program.
 * Returns null when no tsconfig is reachable so callers can fall back to the
 * AST-only pipeline (used by in-repo test fixtures with synthesized file names).
 */

export interface ProgramContext {
  /** Absolute path to the tsconfig this program was built from. */
  tsconfigPath: string;
  program: ts.Program;
  checker: ts.TypeChecker;
}

interface CacheEntry extends ProgramContext {
  /** Set of absolute source file paths reachable from this program. */
  fileSet: Set<string>;
}

const programCache = new Map<string, CacheEntry>();
const tsconfigLookupCache = new Map<string, string | null>();

/** Cap upward walk; keeps the lookup loop bounded if we end up at a
 *  monorepo root with no tsconfig (rare in this repo, but possible if a
 *  caller hands us a path outside the workspace). */
const TSCONFIG_WALK_MAX_DEPTH = 24;

function findTsconfigUpwards(startDir: string): string | null {
  let dir = resolve(startDir);
  const cached = tsconfigLookupCache.get(dir);
  if (cached !== undefined) return cached;

  const visited: string[] = [];
  for (let i = 0; i < TSCONFIG_WALK_MAX_DEPTH; i++) {
    visited.push(dir);
    const candidate = resolve(dir, 'tsconfig.json');
    if (existsSync(candidate)) {
      for (const v of visited) tsconfigLookupCache.set(v, candidate);
      return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) {
      for (const v of visited) tsconfigLookupCache.set(v, null);
      return null;
    }
    dir = parent;
  }
  for (const v of visited) tsconfigLookupCache.set(v, null);
  return null;
}

export interface BuildProgramOptions {
  cacheDir?: string;
}

function buildProgram(tsconfigPath: string, buildOptions: BuildProgramOptions = {}): CacheEntry | null {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) return null;

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(tsconfigPath),
  );
  if (parsedConfig.fileNames.length === 0) return null;

  // `noEmit: true` + `skipLibCheck: true` are the two things that pay back
  // hardest here: we never actually emit (proton does its own codegen) and
  // the lib check is the single biggest cost factor.
  const options: ts.CompilerOptions = {
    ...parsedConfig.options,
    noEmit: true,
    skipLibCheck: parsedConfig.options.skipLibCheck ?? true,
  };
  if (buildOptions.cacheDir) {
    mkdirSync(buildOptions.cacheDir, { recursive: true });
    options.incremental = true;
    options.tsBuildInfoFile = resolve(
      buildOptions.cacheDir,
      `program-${safeFileName(tsconfigPath)}.tsbuildinfo`,
    );
  }

  const program = ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options,
  });

  const checker = program.getTypeChecker();
  const fileSet = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    if (!sf.isDeclarationFile) fileSet.add(normalizePath(sf.fileName));
  }

  return { tsconfigPath, program, checker, fileSet };
}

export function prepareProgramForTsconfig(tsconfigPath: string, options: BuildProgramOptions = {}): ProgramContext | null {
  const abs = resolve(tsconfigPath);
  const built = buildProgram(abs, options);
  if (!built) return null;
  programCache.set(abs, built);
  tsconfigLookupCache.set(dirname(abs), abs);
  return { tsconfigPath: built.tsconfigPath, program: built.program, checker: built.checker };
}

/** Locate (or build) the program that contains `filePath`. Returns null if
 *  no tsconfig is reachable, or if the file isn't part of any program — in
 *  which case the caller MUST fall back to the AST-only pipeline. */
export function getProgramForFile(filePath: string): ProgramContext | null {
  const tsconfigPath = findTsconfigUpwards(dirname(filePath));
  if (!tsconfigPath) return null;

  let entry = programCache.get(tsconfigPath);
  if (!entry) {
    const built = buildProgram(tsconfigPath);
    if (!built) return null;
    entry = built;
    programCache.set(tsconfigPath, entry);
  }

  if (!entry.fileSet.has(normalizePath(filePath))) {
    // File isn't included in this tsconfig (e.g. excluded fixture). The
    // checker would still answer, but using a Program that doesn't actually
    // contain the file leads to subtly wrong symbol lookups.
    return null;
  }

  return { tsconfigPath: entry.tsconfigPath, program: entry.program, checker: entry.checker };
}

/** Drop the cached program containing `filePath`, or all programs if no
 *  argument is given. Called from the plugin's `handleHotUpdate` hook. */
export function invalidateProgramCache(filePath?: string): void {
  if (!filePath) {
    programCache.clear();
    tsconfigLookupCache.clear();
    return;
  }
  const normalized = normalizePath(filePath);
  for (const [tsconfigPath, entry] of programCache) {
    if (entry.fileSet.has(normalized)) {
      programCache.delete(tsconfigPath);
    }
  }
}

function normalizePath(p: string): string {
  return resolve(p).replace(/\\/g, '/');
}

function safeFileName(value: string): string {
  return normalizePath(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
}
