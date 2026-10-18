import { getNativeHookAddon, getNativeHookLoadError } from './injector';

export interface IntegrityReadError {
    status: 'error';
    operation: string;
    code: number;
}

export interface NativeRuntimeIntegrity {
    pid: number;
    executablePath: string | null;
    process: { status: 'ok'; rid: number } | IntegrityReadError;
    file:
        | {
              status: 'ok';
              label: { rid: number; inherited: boolean; policy: number } | null;
          }
        | IntegrityReadError;
}

export type RuntimeIntegrity =
    | { status: 'unsupported' }
    | { status: 'unavailable'; error: string }
    | ({ status: 'available' } & NativeRuntimeIntegrity);

/** File labels can change after startup; only the actual token decides the warning. */
export function hasLowProcessIntegrity(integrity: RuntimeIntegrity): boolean {
    return (
        integrity.status === 'available' &&
        integrity.process.status === 'ok' &&
        integrity.process.rid < 8192
    );
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function uint32(value: unknown): value is number {
    return (
        typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
    );
}

function readError(value: Record<string, unknown>): boolean {
    return value.status === 'error' && typeof value.operation === 'string' && uint32(value.code);
}

function isNativeRuntimeIntegrity(value: unknown): value is NativeRuntimeIntegrity {
    if (
        !record(value) ||
        value.pid !== process.pid ||
        !(typeof value.executablePath === 'string' || value.executablePath === null) ||
        !record(value.process) ||
        !record(value.file)
    ) {
        return false;
    }

    if (!(
        readError(value.process) ||
        (value.process.status === 'ok' && uint32(value.process.rid))
    )) {
        return false;
    }

    const file = value.file;
    return (
        readError(file) ||
        (file.status === 'ok' &&
            (file.label === null ||
                (record(file.label) &&
                    uint32(file.label.rid) &&
                    typeof file.label.inherited === 'boolean' &&
                    uint32(file.label.policy))))
    );
}

let cached: Promise<RuntimeIntegrity> | undefined;

/** One startup snapshot, shared by the startup log and the WebUI warning. */
export function getRuntimeIntegrity(): Promise<RuntimeIntegrity> {
    return (cached ??= readRuntimeIntegrity());
}

async function readRuntimeIntegrity(): Promise<RuntimeIntegrity> {
    if (process.platform !== 'win32') {
        return { status: 'unsupported' };
    }

    try {
        const addon = getNativeHookAddon();

        if (!addon) {
            throw new Error(getNativeHookLoadError() ?? '原生组件不可用');
        }

        if (typeof addon.getRuntimeIntegrityAsync !== 'function') {
            throw new Error('当前原生组件不支持完整性诊断，请更新原生组件');
        }

        const result = await addon.getRuntimeIntegrityAsync();

        if (!isNativeRuntimeIntegrity(result)) {
            throw new Error('原生完整性诊断返回了无效数据');
        }

        return {
            status: 'available',
            pid: result.pid,
            executablePath: result.executablePath,
            process: result.process,
            file: result.file,
        };
    } catch (error) {
        return {
            status: 'unavailable',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
