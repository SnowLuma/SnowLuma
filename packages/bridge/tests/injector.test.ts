import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { existsSyncMock, listPidsMock } = vi.hoisted(() => ({
    existsSyncMock: vi.fn<(target: string) => boolean>(() => false),
    listPidsMock: vi.fn(() => new Set<number>()),
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: (target: Parameters<typeof actual.existsSync>[0]) =>
            existsSyncMock(String(target)),
    };
});

vi.mock('../src/qq-hook-client', () => ({
    listSnowlumaPipePidsSync: listPidsMock,
}));

const NATIVE_PATH_DIR = path.dirname(
    fileURLToPath(new URL('../../common/src/native-path.ts', import.meta.url)),
);
const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ARCH = process.arch;

const HANDLE = {
    base: 0x7fff0000n,
    entry: 0x7fff1234n,
    exceptionTable: 0x7fff5678n,
    size: 8192,
};

function setPlatform(platform: NodeJS.Platform, arch: string): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

function restorePlatform(): void {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
    Object.defineProperty(process, 'arch', { value: ORIGINAL_ARCH, configurable: true });
}

function nativeSearchDirs(): string[] {
    return [
        path.resolve(NATIVE_PATH_DIR, 'native'),
        path.resolve(NATIVE_PATH_DIR, '..', '..', 'runtime', 'native'),
    ];
}

function nativeCandidate(fileName: string, dirIndex: number): string {
    return path.join(nativeSearchDirs()[dirIndex]!, fileName);
}

function allowExisting(paths: readonly string[]): void {
    const allowed = new Set(paths);
    existsSyncMock.mockImplementation((target) => allowed.has(target));
}

function fakeAddon(
    overrides: {
        getAllMainProcessAsync?: number[];
        loadModuleManualAsync?: (pid: number, dylibPath: string) => Promise<typeof HANDLE>;
        unloadModuleManualAsync?: (pid: number, handle: typeof HANDLE) => Promise<void>;
    } = {},
) {
    return {
        getAllMainProcessAsync: vi.fn(async () => overrides.getAllMainProcessAsync ?? []),
        loadModuleManualAsync: vi.fn(overrides.loadModuleManualAsync ?? (async () => HANDLE)),
        unloadModuleManualAsync: vi.fn(
            overrides.unloadModuleManualAsync ?? (async () => undefined),
        ),
    };
}

function installDlopen(addon: object) {
    return vi.spyOn(process, 'dlopen').mockImplementation((mod) => {
        (mod as { exports: object }).exports = addon;
    });
}

async function loadInjector() {
    return import('../src/injector');
}

beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    listPidsMock.mockReset();
    listPidsMock.mockReturnValue(new Set());
    vi.resetModules();
});

afterEach(() => {
    restorePlatform();
    vi.restoreAllMocks();
});

describe('resolveHookNativePath', () => {
    it('returns null after probing every search directory', async () => {
        setPlatform('linux', 'x64');
        const probed: string[] = [];
        existsSyncMock.mockImplementation((target) => {
            probed.push(target);
            return false;
        });

        const { resolveHookNativePath } = await loadInjector();
        expect(resolveHookNativePath('node')).toBeNull();
        expect(probed).toEqual([
            nativeCandidate('snowluma-linux-x64.node', 0),
            nativeCandidate('snowluma-linux-x64.node', 1),
        ]);
    });

    it('returns the first existing candidate and stops scanning', async () => {
        setPlatform('linux', 'x64');
        const winner = nativeCandidate('snowluma-linux-x64.node', 0);
        const later = nativeCandidate('snowluma-linux-x64.node', 1);
        const probed: string[] = [];
        existsSyncMock.mockImplementation((target) => {
            probed.push(target);
            return target === winner || target === later;
        });

        const { resolveHookNativePath } = await loadInjector();
        expect(resolveHookNativePath('node')).toBe(winner);
        expect(probed).toEqual([winner]);
    });

    it('skips missing earlier directories for the injectable .so', async () => {
        setPlatform('linux', 'arm64');
        const winner = nativeCandidate('snowluma-linux-arm64.so', 1);
        allowExisting([winner]);

        const { resolveHookNativePath } = await loadInjector();
        expect(resolveHookNativePath('so')).toBe(winner);
    });

    it('resolves snowluma-win32-x64.dll on win32 x64', async () => {
        setPlatform('win32', 'x64');
        const winner = nativeCandidate('snowluma-win32-x64.dll', 1);
        allowExisting([winner]);

        const { resolveHookNativePath } = await loadInjector();
        expect(resolveHookNativePath('dll')).toBe(winner);
    });

    it('uses the generic platform-arch name on win32 arm64', async () => {
        setPlatform('win32', 'arm64');
        const winner = nativeCandidate('snowluma-win32-arm64.node', 1);
        allowExisting([winner]);

        const { resolveHookNativePath } = await loadInjector();
        expect(resolveHookNativePath('node')).toBe(winner);
    });

    it('does not load an unrelated native addon from the working directory', async () => {
        setPlatform('darwin', 'arm64');
        vi.spyOn(process, 'cwd').mockReturnValue('/tmp/sl-injector-cwd');
        const winner = path.join(
            '/tmp/sl-injector-cwd',
            'dist',
            'native',
            'snowluma-darwin-arm64.node',
        );
        allowExisting([winner]);

        const { resolveHookNativePath } = await loadInjector();
        expect(resolveHookNativePath('node')).toBeNull();
    });
});

describe('getNativeHookAddon / getNativeHookLoadError', () => {
    it('starts with a null load error before any probe', async () => {
        const { getNativeHookLoadError } = await loadInjector();
        expect(getNativeHookLoadError()).toBeNull();
    });

    it('returns null and records a missing-binary error', async () => {
        setPlatform('linux', 'x64');
        const dlopen = vi.spyOn(process, 'dlopen');
        const { getNativeHookAddon, getNativeHookLoadError } = await loadInjector();

        expect(getNativeHookAddon()).toBeNull();
        expect(getNativeHookLoadError()).toBe('No hook native addon found for linux-x64');
        expect(dlopen).not.toHaveBeenCalled();
    });

    it('dlopens the resolved .node once and caches the addon', async () => {
        setPlatform('linux', 'x64');
        const nodePath = nativeCandidate('snowluma-linux-x64.node', 0);
        allowExisting([nodePath]);
        const addon = fakeAddon();
        const dlopen = installDlopen(addon);

        const { getNativeHookAddon, getNativeHookLoadError } = await loadInjector();
        const first = getNativeHookAddon();
        const second = getNativeHookAddon();

        expect(first).toBe(addon);
        expect(second).toBe(addon);
        expect(getNativeHookLoadError()).toBeNull();
        expect(dlopen).toHaveBeenCalledTimes(1);
        expect(dlopen.mock.calls[0]![1]).toBe(nodePath);
    });

    it('stores Error.message when process.dlopen throws', async () => {
        setPlatform('darwin', 'arm64');
        allowExisting([nativeCandidate('snowluma-darwin-arm64.node', 0)]);
        vi.spyOn(process, 'dlopen').mockImplementation(() => {
            throw new Error('not a valid Node addon');
        });

        const { getNativeHookAddon, getNativeHookLoadError } = await loadInjector();
        expect(getNativeHookAddon()).toBeNull();
        expect(getNativeHookLoadError()).toBe('not a valid Node addon');
    });

    it('stringifies a non-Error dlopen failure', async () => {
        setPlatform('linux', 'x64');
        allowExisting([nativeCandidate('snowluma-linux-x64.node', 0)]);
        vi.spyOn(process, 'dlopen').mockImplementation(() => {
            throw 42;
        });

        const { getNativeHookAddon, getNativeHookLoadError } = await loadInjector();
        expect(getNativeHookAddon()).toBeNull();
        expect(getNativeHookLoadError()).toBe('42');
    });

    it('retries after a failed load when a binary later appears', async () => {
        setPlatform('linux', 'x64');
        const nodePath = nativeCandidate('snowluma-linux-x64.node', 1);
        const addon = fakeAddon();
        installDlopen(addon);

        const { getNativeHookAddon, getNativeHookLoadError } = await loadInjector();
        expect(getNativeHookAddon()).toBeNull();
        expect(getNativeHookLoadError()).toBe('No hook native addon found for linux-x64');

        allowExisting([nodePath]);
        expect(getNativeHookAddon()).toBe(addon);
        expect(getNativeHookLoadError()).toBeNull();
    });
});

describe('listHookProcesses', () => {
    it('rejects an obsolete addon without calling its synchronous enumerator', async () => {
        setPlatform('win32', 'x64');
        allowExisting([nativeCandidate('snowluma-win32-x64.node', 0)]);
        const getAllMainProcess = vi.fn(() => [9]);
        installDlopen({ getAllMainProcess });

        const { listHookProcesses } = await loadInjector();
        await expect(listHookProcesses()).rejects.toThrow('getAllMainProcessAsync');
        expect(getAllMainProcess).not.toHaveBeenCalled();
    });

    it('on darwin maps sorted pipe pids without opening the native addon', async () => {
        setPlatform('darwin', 'arm64');
        listPidsMock.mockReturnValue(new Set([42, 7, 15]));
        allowExisting([nativeCandidate('snowluma-darwin-arm64.node', 0)]);
        const dlopen = installDlopen(fakeAddon({ getAllMainProcessAsync: [99] }));

        const { listHookProcesses } = await loadInjector();
        expect(await listHookProcesses()).toEqual([
            { pid: 7, name: 'qq', path: '' },
            { pid: 15, name: 'qq', path: '' },
            { pid: 42, name: 'qq', path: '' },
        ]);
        expect(listPidsMock).toHaveBeenCalledTimes(1);
        expect(dlopen).not.toHaveBeenCalled();
    });

    it('on darwin returns an empty list when no control sockets exist', async () => {
        setPlatform('darwin', 'arm64');
        listPidsMock.mockReturnValue(new Set());

        const { listHookProcesses } = await loadInjector();
        expect(await listHookProcesses()).toEqual([]);
    });

    it('reports a missing addon instead of an empty process set', async () => {
        setPlatform('linux', 'x64');

        const { listHookProcesses } = await loadInjector();
        await expect(listHookProcesses()).rejects.toThrow(
            'No hook native addon found for linux-x64',
        );
    });

    it('on linux dedupes, drops non-positive/non-integer pids, and sorts', async () => {
        setPlatform('linux', 'x64');
        const nodePath = nativeCandidate('snowluma-linux-x64.node', 0);
        allowExisting([nodePath]);
        installDlopen(
            fakeAddon({
                getAllMainProcessAsync: [8, 0, 8, -1, 3.5, 2, Number.NaN, 2],
            }),
        );

        const { listHookProcesses } = await loadInjector();
        expect(await listHookProcesses()).toEqual([
            { pid: 2, name: 'qq', path: '' },
            { pid: 8, name: 'qq', path: '' },
        ]);
    });

    it('on win32 names processes QQ.exe', async () => {
        setPlatform('win32', 'x64');
        allowExisting([nativeCandidate('snowluma-win32-x64.node', 0)]);
        installDlopen(fakeAddon({ getAllMainProcessAsync: [9] }));

        const { listHookProcesses } = await loadInjector();
        expect(await listHookProcesses()).toEqual([{ pid: 9, name: 'QQ.exe', path: '' }]);
    });
});

describe('injectHookProcess', () => {
    it('throws the missing-addon load error', async () => {
        setPlatform('linux', 'x64');
        const { injectHookProcess } = await loadInjector();
        await expect(injectHookProcess(4242)).rejects.toThrow(
            'No hook native addon found for linux-x64',
        );
    });

    it('throws when the addon exists but the injectable is missing', async () => {
        setPlatform('linux', 'x64');
        allowExisting([nativeCandidate('snowluma-linux-x64.node', 0)]);
        installDlopen(fakeAddon());

        const { injectHookProcess } = await loadInjector();
        await expect(injectHookProcess(4242)).rejects.toThrow('No hook so found for linux-x64');
    });

    it('awaits native asynchronous injection', async () => {
        setPlatform('linux', 'x64');
        const nodePath = nativeCandidate('snowluma-linux-x64.node', 0);
        const soPath = nativeCandidate('snowluma-linux-x64.so', 0);
        allowExisting([nodePath, soPath]);
        const addon = fakeAddon({
            loadModuleManualAsync: () => Promise.resolve(HANDLE),
        });
        installDlopen(addon);

        const { injectHookProcess } = await loadInjector();
        await expect(injectHookProcess(4242)).resolves.toEqual({
            method: 'loadModuleManual',
            handle: HANDLE,
        });
        expect(addon.loadModuleManualAsync).toHaveBeenCalledTimes(1);
        expect(addon.loadModuleManualAsync).toHaveBeenCalledWith(4242, soPath);
    });

    it('injects snowluma-win32-x64.dll on win32 x64', async () => {
        setPlatform('win32', 'x64');
        const nodePath = nativeCandidate('snowluma-win32-x64.node', 0);
        const dllPath = nativeCandidate('snowluma-win32-x64.dll', 0);
        allowExisting([nodePath, dllPath]);
        const addon = fakeAddon({ loadModuleManualAsync: async () => HANDLE });
        installDlopen(addon);

        const { injectHookProcess } = await loadInjector();
        await expect(injectHookProcess(5150)).resolves.toEqual({
            method: 'loadModuleManual',
            handle: HANDLE,
        });
        expect(addon.loadModuleManualAsync).toHaveBeenCalledWith(5150, dllPath);
    });

    it('propagates a rejected loadModuleManual', async () => {
        setPlatform('linux', 'x64');
        allowExisting([
            nativeCandidate('snowluma-linux-x64.node', 0),
            nativeCandidate('snowluma-linux-x64.so', 0),
        ]);
        installDlopen(
            fakeAddon({
                loadModuleManualAsync: () => Promise.reject(new Error('map failed')),
            }),
        );

        const { injectHookProcess } = await loadInjector();
        await expect(injectHookProcess(7)).rejects.toThrow('map failed');
    });
});

describe('unloadHookProcess', () => {
    it('propagates native unload rejection', async () => {
        setPlatform('linux', 'x64');
        allowExisting([nativeCandidate('snowluma-linux-x64.node', 0)]);
        installDlopen(
            fakeAddon({
                unloadModuleManualAsync: async () => {
                    throw new Error('unload failed');
                },
            }),
        );
        const { unloadHookProcess } = await loadInjector();
        await expect(unloadHookProcess(4242, HANDLE)).rejects.toThrow('unload failed');
    });

    it('throws the missing-addon load error', async () => {
        setPlatform('linux', 'x64');
        const { unloadHookProcess } = await loadInjector();
        await expect(unloadHookProcess(4242, HANDLE)).rejects.toThrow(
            'No hook native addon found for linux-x64',
        );
    });

    it('forwards pid and handle to unloadModuleManual', async () => {
        setPlatform('linux', 'x64');
        allowExisting([nativeCandidate('snowluma-linux-x64.node', 0)]);
        const addon = fakeAddon();
        installDlopen(addon);

        const { unloadHookProcess } = await loadInjector();
        await expect(unloadHookProcess(4242, HANDLE)).resolves.toBeUndefined();
        expect(addon.unloadModuleManualAsync).toHaveBeenCalledTimes(1);
        expect(addon.unloadModuleManualAsync).toHaveBeenCalledWith(4242, HANDLE);
    });
});
