/**
 * Runtime fallback functions.
 * If the Vite plugin is active, calls to protobuf_encode/decode are replaced
 * at compile-time with generated type-specific functions.
 * If NOT transformed, these fallbacks throw to alert the developer.
 */
import type { MessageRegistry } from './ast/types.js';
import { buildDependencyRegistry } from './ast/dependency-graph.js';
import { generateCode } from './codegen/generator.js';
import {
  normalizeRuntimeMapPath,
  runtimeMapToRegistry,
  type ProtobufRuntimeMap,
  type RuntimeMapCallSite,
  type RuntimeMapFnName,
} from './runtime-map.js';

type DynamicEncode = (params: unknown) => Uint8Array;
type DynamicDecode = (data: Uint8Array) => unknown;

interface DynamicTypeFns {
    encode?: DynamicEncode;
    decode?: DynamicDecode;
}

interface StackFrame {
    file: string;
    line: number;
    column: number;
}

const DYNAMIC_MISS = Symbol('snowluma-proton-dynamic-miss');

let runtimeMapFallback: ProtobufRuntimeMap | null = null;
let runtimeMapRegistry: MessageRegistry | null = null;
let runtimeMapCallSites: RuntimeMapCallSite[] = [];
const dynamicTypeCache = new Map<string, DynamicTypeFns>();

/**
 * Enable dynamic runtime fallback from a pre-collected map file.
 * This is disabled by default.
 */
export function protobuf_enableRuntimeMapFallback(map: ProtobufRuntimeMap): void {
  runtimeMapFallback = map;
  runtimeMapRegistry = runtimeMapToRegistry(map);
  runtimeMapCallSites = map.callSites.map(cs => ({
    ...cs,
    file: normalizeRuntimeMapPath(cs.file),
  }));
  dynamicTypeCache.clear();
}

/** Disable dynamic runtime fallback and clear all generated function caches. */
export function protobuf_disableRuntimeMapFallback(): void {
  runtimeMapFallback = null;
  runtimeMapRegistry = null;
  runtimeMapCallSites = [];
  dynamicTypeCache.clear();
}

export function protobuf_encode<T>(_params: T): Uint8Array {
  const dynamic = tryDynamicInvoke('protobuf_encode', _params);
  if (dynamic !== DYNAMIC_MISS) return dynamic as Uint8Array;

  throw new Error(
    'protobuf_encode<T>() was not transformed by the @snowluma/proton Vite plugin. ' +
        'Make sure protobufVitePlugin() is added to your vite.config.ts plugins array.',
  );
}

export function protobuf_decode<T>(_data: Uint8Array): T {
  const dynamic = tryDynamicInvoke('protobuf_decode', _data);
  if (dynamic !== DYNAMIC_MISS) return dynamic as T;

  throw new Error(
    'protobuf_decode<T>() was not transformed by the @snowluma/proton Vite plugin. ' +
        'Make sure protobufVitePlugin() is added to your vite.config.ts plugins array.',
  );
}

function tryDynamicInvoke(fnName: RuntimeMapFnName, payload: unknown): unknown {
  if (!runtimeMapFallback || runtimeMapFallback.version !== 1 || !runtimeMapRegistry) {
    return DYNAMIC_MISS;
  }

  const caller = getFirstUserFrame();
  if (!caller) return DYNAMIC_MISS;

  const callSite = resolveCallSite(fnName, caller);
  if (!callSite) return DYNAMIC_MISS;

  const typeFns = ensureTypeFunctions(callSite.typeName);
  if (!typeFns) return DYNAMIC_MISS;

  const fn = fnName === 'protobuf_encode' ? typeFns.encode : typeFns.decode;
  if (typeof fn !== 'function') return DYNAMIC_MISS;

  return fn(payload as never);
}

function ensureTypeFunctions(typeName: string): DynamicTypeFns | null {
  const cached = dynamicTypeCache.get(typeName);
  if (cached) return cached;
  if (!runtimeMapRegistry || !runtimeMapRegistry.has(typeName)) return null;

  const subset = buildDependencyRegistry(runtimeMapRegistry, [typeName]);
  if (subset.size === 0) return null;

  const generated = generateCode(subset);
  if (!generated) return null;

  const factory = new Function(
    `${generated}\nreturn {\n` +
        `  encode: typeof protobuf_encode_${typeName} === 'function' ? protobuf_encode_${typeName} : undefined,\n` +
        `  decode: typeof protobuf_decode_${typeName} === 'function' ? protobuf_decode_${typeName} : undefined,\n` +
        `};`,
  ) as () => DynamicTypeFns;

  const compiled = factory();
  dynamicTypeCache.set(typeName, compiled);
  return compiled;
}

function resolveCallSite(fnName: RuntimeMapFnName, caller: StackFrame): RuntimeMapCallSite | null {
  const callerFile = normalizeRuntimeMapPath(caller.file);

  const candidates = runtimeMapCallSites.filter(cs =>
    cs.fnName === fnName &&
        cs.line === caller.line &&
        pathsLikelySame(callerFile, cs.file),
  );

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let best = candidates[0];
  let bestDistance = Math.abs(best.column - caller.column);
  for (let i = 1; i < candidates.length; i++) {
    const dist = Math.abs(candidates[i].column - caller.column);
    if (dist < bestDistance) {
      best = candidates[i];
      bestDistance = dist;
    }
  }
  return best;
}

function getFirstUserFrame(): StackFrame | null {
  const err = new Error();
  if (!err.stack) return null;

  const lines = err.stack.split('\n').slice(1);
  for (const raw of lines) {
    const frame = parseStackLine(raw);
    if (!frame) continue;

    const file = normalizeRuntimeMapPath(frame.file);
    if (isRuntimeInternalFile(file)) continue;

    return {
      file,
      line: frame.line,
      column: frame.column,
    };
  }

  return null;
}

function parseStackLine(line: string): StackFrame | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let location = trimmed;
  const atPrefix = 'at ';
  if (location.startsWith(atPrefix)) {
    location = location.slice(atPrefix.length).trim();
  }

  const openParen = location.lastIndexOf('(');
  if (openParen >= 0 && location.endsWith(')')) {
    location = location.slice(openParen + 1, -1);
  }

  const lastColon = location.lastIndexOf(':');
  if (lastColon < 0) return null;
  const secondLastColon = location.lastIndexOf(':', lastColon - 1);
  if (secondLastColon < 0) return null;

  const file = location.slice(0, secondLastColon);
  const linePart = location.slice(secondLastColon + 1, lastColon);
  const colPart = location.slice(lastColon + 1);

  const parsedLine = Number(linePart);
  const parsedCol = Number(colPart);
  if (!Number.isFinite(parsedLine) || !Number.isFinite(parsedCol)) return null;

  return {
    file,
    line: parsedLine,
    column: parsedCol,
  };
}

function isRuntimeInternalFile(file: string): boolean {
  return file.endsWith('/runtime.ts') || file.endsWith('/runtime.js') || file.includes('/dist/runtime.js');
}

function pathsLikelySame(a: string, b: string): boolean {
  if (a === b) return true;
  const aBase = basename(a);
  const bBase = basename(b);
  return aBase !== '' && aBase === bBase;
}

function basename(file: string): string {
  const normalized = normalizeRuntimeMapPath(file);
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
