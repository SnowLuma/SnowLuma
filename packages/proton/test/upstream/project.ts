import { build } from 'vite';
import protobufPlugin from '../../src/index';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, posix } from 'node:path';
import { packageName } from '../../src/package';

export async function withProject<T>(
    files: Record<string, string>,
    action: (directory: string) => T | Promise<T>,
): Promise<T> {
    const directory = mkdtempSync(join(tmpdir(), 'protobuf-compiler-'));

    try {
        for (const [name, text] of Object.entries(files)) {
            const path = join(directory, name);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, text);
        }

        return await action(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

export function bundle(
    files: Record<string, string>,
    entry: string | string[] = 'entry.ts',
): Promise<any> {
    return withProject(files, async (directory) => {
        const output = await build({
            configFile: false,
            root: directory,
            logLevel: 'silent',
            plugins: [protobufPlugin()],
            build: {
                write: false,
                minify: false,
                target: 'es2022',
                lib: {
                    entry: Array.isArray(entry)
                        ? entry.map((file) => join(directory, file))
                        : join(directory, entry),
                    formats: ['cjs'],
                },
                rolldownOptions: { external: [packageName] },
            },
        });
        const result = (Array.isArray(output) ? output[0] : output) as {
            output: { code?: string; fileName: string; name: string; isEntry?: boolean }[];
        };
        const cache = new Map<string, Record<string, unknown>>();

        const load = (name: string): Record<string, unknown> => {
            if (cache.has(name)) {
                return cache.get(name)!;
            }

            const chunk = result.output.find((chunk) => chunk.fileName === name);

            if (!chunk?.code) {
                throw new Error(`Unexpected runtime dependency: ${name}`);
            }

            const exports = {};
            cache.set(name, exports);
            new Function('exports', 'require', chunk.code)(exports, (specifier: string) =>
                load(posix.normalize(posix.join(posix.dirname(name), specifier))),
            );
            return Object.fromEntries(Object.entries(exports));
        };

        const entries = result.output.filter((chunk) => chunk.isEntry);
        return Array.isArray(entry)
            ? Object.fromEntries(entries.map((chunk) => [chunk.name, load(chunk.fileName)]))
            : load(entries[0].fileName);
    });
}
