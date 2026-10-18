import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasLowProcessIntegrity, type NativeRuntimeIntegrity } from '../src/runtime-integrity';

const native = vi.hoisted(() => ({ load: vi.fn(), error: vi.fn() }));
vi.mock('../src/injector', () => ({
    getNativeHookAddon: native.load,
    getNativeHookLoadError: native.error,
}));

const platform = process.platform;
const sample = (): NativeRuntimeIntegrity => ({
    pid: process.pid,
    executablePath: process.execPath,
    process: { status: 'ok', rid: 8192 },
    file: { status: 'ok', label: null },
});

beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});

afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});

describe('runtime integrity diagnostics', () => {
    it('warns only for a successfully read process token below Medium', () => {
        const available = { ...sample(), status: 'available' as const };

        for (const rid of [0, 4096]) {
            expect(hasLowProcessIntegrity({ ...available, process: { status: 'ok', rid } })).toBe(
                true,
            );
        }

        for (const rid of [8192, 8448, 12288, 16384]) {
            expect(
                hasLowProcessIntegrity({
                    ...available,
                    process: { status: 'ok', rid },
                    file: { status: 'ok', label: { rid: 4096, inherited: true, policy: 1 } },
                }),
            ).toBe(false);
        }

        expect(hasLowProcessIntegrity({ status: 'unsupported' })).toBe(false);
        expect(hasLowProcessIntegrity({ status: 'unavailable', error: 'unavailable' })).toBe(false);
        expect(
            hasLowProcessIntegrity({
                ...available,
                process: { status: 'error', operation: 'OpenProcessToken', code: 5 },
            }),
        ).toBe(false);
    });

    it('keeps one startup snapshot for logging and all WebUI polls', async () => {
        const read = vi.fn().mockResolvedValue(sample());
        native.load.mockReturnValue({ getRuntimeIntegrityAsync: read });
        const { getRuntimeIntegrity } = await import('../src/runtime-integrity');
        const pending = getRuntimeIntegrity();
        expect(getRuntimeIntegrity()).toBe(pending);
        const first = await pending;
        expect(first).toMatchObject({
            status: 'available',
            process: { rid: 8192 },
            file: { label: null },
        });
        read.mockResolvedValue({
            ...sample(),
            file: { status: 'ok', label: { rid: 4096, inherited: true, policy: 1 } },
        });
        expect(await getRuntimeIntegrity()).toBe(first);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it.each(['process', 'file'])(
        'retains %s query errors and the other successful result',
        async (field) => {
            native.load.mockReturnValue({
                getRuntimeIntegrityAsync: async () => ({
                    ...sample(),
                    [field]: { status: 'error', operation: 'Win32Query', code: 5 },
                }),
            });
            const { getRuntimeIntegrity } = await import('../src/runtime-integrity');
            expect(await getRuntimeIntegrity()).toMatchObject({
                status: 'available',
                [field]: { status: 'error', operation: 'Win32Query', code: 5 },
            });
        },
    );

    it('reports old addons as unavailable rather than Medium', async () => {
        native.load.mockReturnValue({});
        const { getRuntimeIntegrity } = await import('../src/runtime-integrity');
        expect(await getRuntimeIntegrity()).toMatchObject({
            status: 'unavailable',
            error: expect.stringContaining('不支持'),
        });
    });

    it('retains the loader error for the startup log', async () => {
        native.load.mockReturnValue(null);
        native.error.mockReturnValue('dlopen failed: incompatible binary');
        const { getRuntimeIntegrity } = await import('../src/runtime-integrity');
        expect(await getRuntimeIntegrity()).toMatchObject({
            status: 'unavailable',
            error: 'dlopen failed: incompatible binary',
        });
    });

    it.each([
        null,
        { ...sample(), pid: process.pid + 1 },
        { ...sample(), process: { status: 'ok', rid: -1 } },
        { ...sample(), file: { status: 'ok', label: { rid: 4096, inherited: 'yes', policy: 1 } } },
    ])('rejects malformed or wrong-process native results', async (result) => {
        native.load.mockReturnValue({ getRuntimeIntegrityAsync: async () => result });
        const { getRuntimeIntegrity } = await import('../src/runtime-integrity');
        expect(await getRuntimeIntegrity()).toMatchObject({
            status: 'unavailable',
            error: expect.stringContaining('无效数据'),
        });
    });

    it('preserves rejected errors without repeatedly probing on WebUI polls', async () => {
        const read = vi
            .fn()
            .mockRejectedValueOnce(new Error('allocation failed'))
            .mockResolvedValue(sample());
        native.load.mockReturnValue({ getRuntimeIntegrityAsync: read });
        const { getRuntimeIntegrity } = await import('../src/runtime-integrity');
        expect(await getRuntimeIntegrity()).toMatchObject({
            status: 'unavailable',
            error: 'allocation failed',
        });
        expect(await getRuntimeIntegrity()).toMatchObject({
            status: 'unavailable',
            error: 'allocation failed',
        });
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('does not load the addon on non-Windows hosts', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        const { getRuntimeIntegrity } = await import('../src/runtime-integrity');
        expect(await getRuntimeIntegrity()).toEqual({ status: 'unsupported' });
        expect(native.load).not.toHaveBeenCalled();
    });
});
