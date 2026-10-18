import { errorMessage } from '@snowluma/common/errors';
import { resolveRuntimeNativePath } from '@snowluma/common/native-path';

import { listSnowlumaPipePidsSync } from './qq-hook-client';

export interface ManualMapHandle {
    base: bigint;
    entry: bigint;
    exceptionTable: bigint;
    size: number;
}

interface NativeHookAddon {
    getRuntimeIntegrityAsync(): Promise<unknown>;
    getAllMainProcessAsync(): Promise<number[]>;
    getFileHoldersAsync(path: string): Promise<{ pid: number; name: string }[]>;
    loadModuleManualAsync(pid: number, dylibPath: string): Promise<ManualMapHandle>;
    unloadModuleManualAsync(pid: number, handle: ManualMapHandle): Promise<void>;
}

export interface HookProcessBaseInfo {
    pid: number;
    name: string;
    path: string;
}

export interface HookInjectResult {
    method: 'loadModuleManual';
    handle: ManualMapHandle;
}

let nativeAddon: NativeHookAddon | null = null;
let nativeLoadError: string | null = null;

function loadNativeAddon(addonPath: string): NativeHookAddon {
    const mod = { exports: {} as Record<string, unknown> };
    process.dlopen(mod, addonPath);
    return mod.exports as unknown as NativeHookAddon;
}

type HookBinaryExt = 'node' | 'dll' | 'so';

function platformInjectableExt(): 'dll' | 'so' {
    return process.platform === 'win32' ? 'dll' : 'so';
}

function defaultProcessName(): string {
    return process.platform === 'win32' ? 'QQ.exe' : 'qq';
}

export function resolveHookNativePath(ext: HookBinaryExt): string | null {
    return resolveRuntimeNativePath(`snowluma-${process.platform}-${process.arch}.${ext}`);
}

export function getNativeHookAddon(): NativeHookAddon | null {
    if (nativeAddon) {
        return nativeAddon;
    }

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
        nativeLoadError = errorMessage(error);
        return null;
    }
}

export function getNativeHookLoadError(): string | null {
    return nativeLoadError;
}

export async function listHookProcesses(): Promise<HookProcessBaseInfo[]> {
    // macOS: no native enumerate-QQ addon. The DYLD_INSERT injection model
    // means QQ ran with our dylib already mapped, so the dylib's listener
    // socket IS the discovery signal. Treat every `mojo.<pid>.control.sock`
    // in the runtime dir as a known process (the watcher's subsequent
    // connectable-probe gates the pipe-up emit, so a stale dangling socket
    // here doesn't drive a false connect).
    if (process.platform === 'darwin') {
        return [...listSnowlumaPipePidsSync()]
            .sort((a, b) => a - b)
            .map((pid) => ({ pid, name: defaultProcessName(), path: '' }));
    }

    const addon = getNativeHookAddon();

    if (!addon) {
        throw new Error(getNativeHookLoadError() ?? 'hook native addon is not available');
    }

    if (typeof addon.getAllMainProcessAsync !== 'function') {
        throw new Error(
            'Hook native addon lacks getAllMainProcessAsync; update the native artifacts',
        );
    }

    return [...new Set(await addon.getAllMainProcessAsync())]
        .filter((pid) => Number.isInteger(pid) && pid > 0)
        .sort((a, b) => a - b)
        .map((pid) => ({ pid, name: defaultProcessName(), path: '' }));
}

export async function injectHookProcess(pid: number): Promise<HookInjectResult> {
    const addon = getNativeHookAddon();

    if (!addon) {
        throw new Error(getNativeHookLoadError() ?? 'hook native addon is not available');
    }

    const injectableExt = platformInjectableExt();
    const dllPath = resolveHookNativePath(injectableExt);

    if (!dllPath) {
        throw new Error(`No hook ${injectableExt} found for ${process.platform}-${process.arch}`);
    }

    return { method: 'loadModuleManual', handle: await addon.loadModuleManualAsync(pid, dllPath) };
}

export async function unloadHookProcess(pid: number, handle: ManualMapHandle): Promise<void> {
    const addon = getNativeHookAddon();

    if (!addon) {
        throw new Error(getNativeHookLoadError() ?? 'hook native addon is not available');
    }

    await addon.unloadModuleManualAsync(pid, handle);
}
