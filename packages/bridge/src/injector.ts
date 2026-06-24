import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { listSnowlumaPipePidsSync } from './qq-hook-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ManualMapHandle {
  base: bigint;
  entry: bigint;
  exceptionTable: bigint;
  size: number;
}

interface NativeHookAddon {
  getAllMainProcess(): number[];
  loadModuleManual(pid: number, dylibPath: string): ManualMapHandle;
  unloadModuleManual(pid: number, handle: ManualMapHandle): void;
}

export interface HookProcessBaseInfo {
  pid: number;
  name: string;
  path: string;
}

export interface HookInjectResult {
  method: 'loadModuleManual';
  handle?: ManualMapHandle;
}

let nativeAddon: NativeHookAddon | null = null;
let nativeLoadError: string | null = null;

function loadNativeAddon(addonPath: string): NativeHookAddon {
  const mod = { exports: {} as Record<string, unknown> };
  process.dlopen(mod, addonPath);
  return mod.exports as unknown as NativeHookAddon;
}

type HookBinaryExt = 'node' | 'dll' | 'so';

function platformBinaryName(ext: HookBinaryExt): string {
  if (process.platform === 'win32' && process.arch === 'x64') return `snowluma-win32-x64.${ext}`;
  return `snowluma-${process.platform}-${process.arch}.${ext}`;
}

function platformInjectableExt(): 'dll' | 'so' {
  return process.platform === 'win32' ? 'dll' : 'so';
}

function defaultProcessName(): string {
  return process.platform === 'win32' ? 'QQ.exe' : 'qq';
}

function nativeSearchDirs(): string[] {
  // Several layouts must be supported:
  //   1. Released zip (flattened dist/): __dirname=<extracted>/, native at <extracted>/native
  //   2. Dev via tsx (packages/bridge/src/injector.ts): __dirname=<root>/packages/bridge/src
  //      → walk up to <root>/packages and append runtime/native
  //      Same offset works for `packages/bridge/dist/index.mjs` after build.
  //   3. cwd-based fallback when neither __dirname-relative path resolves.
  return [
    path.resolve(__dirname, 'native'),
    path.resolve(__dirname, '..', '..', 'runtime', 'native'),
    path.resolve(process.cwd(), 'dist', 'native'),
    path.resolve(process.cwd(), 'packages', 'runtime', 'native'),
  ];
}

export function resolveHookNativePath(ext: HookBinaryExt): string | null {
  const fileName = platformBinaryName(ext);
  for (const dir of nativeSearchDirs()) {
    const fullPath = path.join(dir, fileName);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

export function getNativeHookAddon(): NativeHookAddon | null {
  if (nativeAddon) return nativeAddon;
  const addonPath = resolveHookNativePath('node');
  if (!addonPath) {
    nativeLoadError = `No hook native addon found for ${process.platform}-${process.arch}`;
    return null;
  }
  try {
    nativeAddon = loadNativeAddon(addonPath);
    nativeLoadError = null;
    return nativeAddon;
  } catch (error) {
    nativeLoadError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

export function getNativeHookLoadError(): string | null {
  return nativeLoadError;
}

export function listHookProcesses(): HookProcessBaseInfo[] {
  // macOS: no native enumerate-QQ addon. The DYLD_INSERT injection model
  // means QQ ran with our dylib already mapped, so the dylib's listener
  // socket IS the discovery signal. Treat every `mojo.<pid>.control.sock`
  // in the runtime dir as a known process (the watcher's subsequent
  // connectable-probe gates the pipe-up emit, so a stale dangling socket
  // here doesn't drive a false connect).
  if (process.platform === 'darwin') {
    return [...listSnowlumaPipePidsSync()]
      .sort((a, b) => a - b)
      .map(pid => ({ pid, name: defaultProcessName(), path: '' }));
  }
  const addon = getNativeHookAddon();
  if (!addon) return [];
  return [...new Set(addon.getAllMainProcess())]
    .filter(pid => Number.isInteger(pid) && pid > 0)
    .sort((a, b) => a - b)
    .map(pid => ({ pid, name: defaultProcessName(), path: '' }));
}

export function injectHookProcess(pid: number): HookInjectResult {
  const addon = getNativeHookAddon();
  if (!addon) {
    throw new Error(getNativeHookLoadError() ?? 'hook native addon is not available');
  }
  const injectableExt = platformInjectableExt();
  const dllPath = resolveHookNativePath(injectableExt);
  if (!dllPath) {
    throw new Error(`No hook ${injectableExt} found for ${process.platform}-${process.arch}`);
  }
  return { method: 'loadModuleManual', handle: addon.loadModuleManual(pid, dllPath) };
}

export function unloadHookProcess(pid: number, handle: ManualMapHandle): void {
  const addon = getNativeHookAddon();
  if (!addon) {
    throw new Error(getNativeHookLoadError() ?? 'hook native addon is not available');
  }
  addon.unloadModuleManual(pid, handle);
}
