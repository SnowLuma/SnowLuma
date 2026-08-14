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

const INJECTOR_DIR = path.dirname(fileURLToPath(new URL('../src/injector.ts', import.meta.url)));
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

function nativeSearchDirs(cwd = process.cwd()): string[] {
  return [
    path.resolve(INJECTOR_DIR, 'native'),
    path.resolve(INJECTOR_DIR, '..', '..', 'runtime', 'native'),
    path.resolve(cwd, 'dist', 'native'),
    path.resolve(cwd, 'packages', 'runtime', 'native'),
  ];
}

function nativeCandidate(fileName: string, dirIndex: number, cwd = process.cwd()): string {
  return path.join(nativeSearchDirs(cwd)[dirIndex]!, fileName);
}

function allowExisting(paths: readonly string[]): void {
  const allowed = new Set(paths);
  existsSyncMock.mockImplementation((target) => allowed.has(target));
}

function fakeAddon(overrides: {
  getAllMainProcess?: number[];
  loadModuleManual?: (pid: number, dylibPath: string) => unknown;
  unloadModuleManual?: (pid: number, handle: typeof HANDLE) => void;
} = {}) {
  return {
    getAllMainProcess: vi.fn(() => overrides.getAllMainProcess ?? []),
    loadModuleManual: vi.fn(overrides.loadModuleManual ?? (() => HANDLE)),
    unloadModuleManual: vi.fn(overrides.unloadModuleManual ?? (() => undefined)),
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
      nativeCandidate('snowluma-linux-x64.node', 2),
      nativeCandidate('snowluma-linux-x64.node', 3),
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
    const winner = nativeCandidate('snowluma-linux-arm64.so', 2);
    allowExisting([winner]);

    const { resolveHookNativePath } = await loadInjector();
    expect(resolveHookNativePath('so')).toBe(winner);
  });

  it('resolves snowluma-win32-x64.dll on win32 x64', async () => {
    setPlatform('win32', 'x64');
    const winner = nativeCandidate('snowluma-win32-x64.dll', 3);
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

  it('re-reads process.cwd() for the dist/native fallback', async () => {
    setPlatform('darwin', 'arm64');
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp/sl-injector-cwd');
    const winner = path.join('/tmp/sl-injector-cwd', 'dist', 'native', 'snowluma-darwin-arm64.node');
    allowExisting([winner]);

    const { resolveHookNativePath } = await loadInjector();
    expect(resolveHookNativePath('node')).toBe(winner);
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
  it('on darwin maps sorted pipe pids without opening the native addon', async () => {
    setPlatform('darwin', 'arm64');
    listPidsMock.mockReturnValue(new Set([42, 7, 15]));
    allowExisting([nativeCandidate('snowluma-darwin-arm64.node', 0)]);
    const dlopen = installDlopen(fakeAddon({ getAllMainProcess: [99] }));

    const { listHookProcesses } = await loadInjector();
    expect(listHookProcesses()).toEqual([
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
    expect(listHookProcesses()).toEqual([]);
  });

  it('on non-darwin returns [] when the addon cannot be loaded', async () => {
    setPlatform('linux', 'x64');

    const { listHookProcesses } = await loadInjector();
    expect(listHookProcesses()).toEqual([]);
  });

  it('on linux dedupes, drops non-positive/non-integer pids, and sorts', async () => {
    setPlatform('linux', 'x64');
    const nodePath = nativeCandidate('snowluma-linux-x64.node', 0);
    allowExisting([nodePath]);
    installDlopen(fakeAddon({
      getAllMainProcess: [8, 0, 8, -1, 3.5, 2, Number.NaN, 2],
    }));

    const { listHookProcesses } = await loadInjector();
    expect(listHookProcesses()).toEqual([
      { pid: 2, name: 'qq', path: '' },
      { pid: 8, name: 'qq', path: '' },
    ]);
  });

  it('on win32 names processes QQ.exe', async () => {
    setPlatform('win32', 'x64');
    allowExisting([nativeCandidate('snowluma-win32-x64.node', 0)]);
    installDlopen(fakeAddon({ getAllMainProcess: [9] }));

    const { listHookProcesses } = await loadInjector();
    expect(listHookProcesses()).toEqual([
      { pid: 9, name: 'QQ.exe', path: '' },
    ]);
  });
});

describe('injectHookProcess', () => {
  it('throws the missing-addon load error', async () => {
    setPlatform('linux', 'x64');
    const { injectHookProcess } = await loadInjector();
    await expect(injectHookProcess(4242)).rejects.toThrow('No hook native addon found for linux-x64');
  });

  it('throws when the addon exists but the injectable is missing', async () => {
    setPlatform('linux', 'x64');
    allowExisting([nativeCandidate('snowluma-linux-x64.node', 0)]);
    installDlopen(fakeAddon());

    const { injectHookProcess } = await loadInjector();
    await expect(injectHookProcess(4242)).rejects.toThrow('No hook so found for linux-x64');
  });

  it('awaits a thenable loadModuleManual handle', async () => {
    setPlatform('linux', 'x64');
    const nodePath = nativeCandidate('snowluma-linux-x64.node', 0);
    const soPath = nativeCandidate('snowluma-linux-x64.so', 0);
    allowExisting([nodePath, soPath]);
    const addon = fakeAddon({
      loadModuleManual: () => Promise.resolve(HANDLE),
    });
    installDlopen(addon);

    const { injectHookProcess } = await loadInjector();
    await expect(injectHookProcess(4242)).resolves.toEqual({
      method: 'loadModuleManual',
      handle: HANDLE,
    });
    expect(addon.loadModuleManual).toHaveBeenCalledTimes(1);
    expect(addon.loadModuleManual).toHaveBeenCalledWith(4242, soPath);
  });

  it('accepts a synchronous loadModuleManual return value', async () => {
    setPlatform('darwin', 'arm64');
    const nodePath = nativeCandidate('snowluma-darwin-arm64.node', 2);
    const soPath = nativeCandidate('snowluma-darwin-arm64.so', 3);
    allowExisting([nodePath, soPath]);
    const addon = fakeAddon({ loadModuleManual: () => HANDLE });
    installDlopen(addon);

    const { injectHookProcess } = await loadInjector();
    await expect(injectHookProcess(77)).resolves.toEqual({
      method: 'loadModuleManual',
      handle: HANDLE,
    });
    expect(addon.loadModuleManual).toHaveBeenCalledWith(77, soPath);
  });

  it('injects snowluma-win32-x64.dll on win32 x64', async () => {
    setPlatform('win32', 'x64');
    const nodePath = nativeCandidate('snowluma-win32-x64.node', 0);
    const dllPath = nativeCandidate('snowluma-win32-x64.dll', 0);
    allowExisting([nodePath, dllPath]);
    const addon = fakeAddon({ loadModuleManual: () => HANDLE });
    installDlopen(addon);

    const { injectHookProcess } = await loadInjector();
    await expect(injectHookProcess(5150)).resolves.toEqual({
      method: 'loadModuleManual',
      handle: HANDLE,
    });
    expect(addon.loadModuleManual).toHaveBeenCalledWith(5150, dllPath);
  });

  it('propagates a rejected loadModuleManual', async () => {
    setPlatform('linux', 'x64');
    allowExisting([
      nativeCandidate('snowluma-linux-x64.node', 0),
      nativeCandidate('snowluma-linux-x64.so', 0),
    ]);
    installDlopen(fakeAddon({
      loadModuleManual: () => Promise.reject(new Error('map failed')),
    }));

    const { injectHookProcess } = await loadInjector();
    await expect(injectHookProcess(7)).rejects.toThrow('map failed');
  });
});

describe('unloadHookProcess', () => {
  it('throws the missing-addon load error', async () => {
    setPlatform('linux', 'x64');
    const { unloadHookProcess } = await loadInjector();
    expect(() => unloadHookProcess(4242, HANDLE)).toThrow('No hook native addon found for linux-x64');
  });

  it('forwards pid and handle to unloadModuleManual', async () => {
    setPlatform('linux', 'x64');
    allowExisting([nativeCandidate('snowluma-linux-x64.node', 0)]);
    const addon = fakeAddon();
    installDlopen(addon);

    const { unloadHookProcess } = await loadInjector();
    expect(unloadHookProcess(4242, HANDLE)).toBeUndefined();
    expect(addon.unloadModuleManual).toHaveBeenCalledTimes(1);
    expect(addon.unloadModuleManual).toHaveBeenCalledWith(4242, HANDLE);
  });
});
