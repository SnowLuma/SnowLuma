import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Load a fixture file as a string. */
export function loadFixture(name: string): string {
    return readFileSync(resolve(fixturesDir, name), 'utf-8');
}

/**
 * Run generated code via `new Function()` and return a named global value.
 * Cleans up the global after retrieval.
 */
export function execAndGet<T>(code: string, globalKey: string): T {
    new Function(code)();
    const val = (globalThis as any)[globalKey] as T;
    delete (globalThis as any)[globalKey];
    return val;
}
