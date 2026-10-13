import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    assertRuntime,
    NATIVE_INTERFACE_VERSION,
    RELEASE_PREBUILDS,
    runtimeLibc,
    runtimePrebuild,
} from './layout';

// Only the callback ABI used by SnowLuma is exposed. No upstream JavaScript,
// convenience methods, synchronous SQL methods or node-gyp resolver are loaded.
export type BindValue =
    | string
    | number
    | bigint
    | boolean
    | null
    | undefined
    | Uint8Array
    | ArrayBuffer
    | DataView
    | Date
    | RegExp;
export type Row = Record<string, unknown>;
type Done = (error: Error | null) => void;

export interface NativeDatabase {
    exec(sql: string, callback: Done): void;
    close(callback: Done): void;
}

export interface NativeStatement {
    run(parameters: BindValue[], callback: Done): void;
    get(
        parameters: BindValue[],
        callback: (error: Error | null, row: Row | undefined) => void,
    ): void;
    all(parameters: BindValue[], callback: (error: Error | null, rows: Row[]) => void): void;
    reset(callback: Done): void;
    finalize(callback: Done): void;
    readonly changes: number | undefined;
    readonly lastIDBigInt: bigint | undefined;
}

interface NativeBinding {
    NATIVE_INTERFACE_VERSION: number;
    OPEN_READONLY: number;
    OPEN_READWRITE: number;
    OPEN_CREATE: number;
    OPEN_FULLMUTEX: number;
    Database: new (
        filename: string,
        mode: number,
        callback: (this: NativeDatabase, error: Error | null) => void,
    ) => NativeDatabase;
    Statement: new (
        database: NativeDatabase,
        sql: string,
        callback: (this: NativeStatement, error: Error | null) => void,
    ) => NativeStatement;
}

function assertBinding(value: unknown): asserts value is NativeBinding {
    if (
        !value ||
        typeof value !== 'object' ||
        !('NATIVE_INTERFACE_VERSION' in value) ||
        value.NATIVE_INTERFACE_VERSION !== NATIVE_INTERFACE_VERSION ||
        !('Database' in value) ||
        typeof value.Database !== 'function' ||
        !('Statement' in value) ||
        typeof value.Statement !== 'function' ||
        !('OPEN_READONLY' in value) ||
        value.OPEN_READONLY !== 1 ||
        !('OPEN_READWRITE' in value) ||
        value.OPEN_READWRITE !== 2 ||
        !('OPEN_CREATE' in value) ||
        value.OPEN_CREATE !== 4 ||
        !('OPEN_FULLMUTEX' in value) ||
        value.OPEN_FULLMUTEX !== 0x10000
    ) {
        throw new Error(
            `SQLite native interface mismatch; expected interface ${NATIVE_INTERFACE_VERSION}`,
        );
    }
}

declare const __SNOWLUMA_SQLITE_RELEASE__: boolean;
let binding: NativeBinding | undefined;

export function loadNative(): NativeBinding {
    if (binding) {
        return binding;
    }

    assertRuntime(process.versions.node, process.versions.napi);
    const libc = process.platform === 'linux' ? runtimeLibc(process.report.getReport()) : undefined;
    const file = runtimePrebuild(process.platform, process.arch, libc);
    // Vite makes the release branch constant. A missing release binary must fail,
    // never fall back to another install, the working directory or a local build.
    const root =
        typeof __SNOWLUMA_SQLITE_RELEASE__ !== 'undefined' && __SNOWLUMA_SQLITE_RELEASE__
            ? fileURLToPath(new URL(RELEASE_PREBUILDS, import.meta.url))
            : path.join(
                  path.dirname(
                      createRequire(import.meta.url).resolve('@appthreat/sqlite3/package.json'),
                  ),
                  'prebuilds',
              );
    const filename = path.join(root, file);

    try {
        const module: { exports: unknown } = { exports: {} };
        process.dlopen(module, filename);
        assertBinding(module.exports);
        // The native constructors emit open/close/error events even when callbacks
        // are supplied, and expect EventEmitter methods on their prototypes.
        Object.assign(module.exports.Database.prototype, EventEmitter.prototype);
        Object.assign(module.exports.Statement.prototype, EventEmitter.prototype);
        binding = module.exports;
        return binding;
    } catch (cause) {
        throw new Error(`Failed to load SQLite native addon: ${filename}`, { cause });
    }
}
