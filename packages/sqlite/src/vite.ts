import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';
import { DRIVER_VERSION, NATIVE_INTERFACE_VERSION, prebuildFiles } from './layout.ts';

/** Upstream is a locked prebuild source, never a runtime JS or installer dependency. */
export function sqliteBuildPlugin(target: string): Plugin {
    const require = createRequire(import.meta.url);
    const driverRoot = path.dirname(require.resolve('@appthreat/sqlite3/package.json'));
    const metadata: unknown = JSON.parse(
        fs.readFileSync(path.join(driverRoot, 'package.json'), 'utf8'),
    );

    if (
        !metadata ||
        typeof metadata !== 'object' ||
        !('version' in metadata) ||
        metadata.version !== DRIVER_VERSION
    ) {
        throw new Error(
            `SQLite prebuild version mismatch; expected @appthreat/sqlite3 ${DRIVER_VERSION}`,
        );
    }

    const files = prebuildFiles(target).map((file) => `prebuilds/${file}`);
    const assets = [
        ...files.map((file) => ({ file, source: path.join(driverRoot, file) })),
        { file: 'LICENSE.sqlite3', source: path.join(driverRoot, 'LICENSE') },
    ];

    for (const asset of assets) {
        if (!fs.statSync(asset.source, { throwIfNoEntry: false })?.isFile()) {
            throw new Error(`Missing SQLite release input for ${target}: ${asset.source}`);
        }
    }

    return {
        name: 'snowluma-sqlite-prebuilds',
        config: () => ({ define: { __SNOWLUMA_SQLITE_RELEASE__: 'true' } }),
        generateBundle() {
            for (const asset of assets) {
                this.emitFile({
                    type: 'asset',
                    fileName: `native/sqlite/${asset.file}`,
                    source: fs.readFileSync(asset.source),
                });
            }

            this.emitFile({
                type: 'asset',
                fileName: 'native/sqlite/manifest.json',
                source:
                    JSON.stringify(
                        {
                            package: '@appthreat/sqlite3',
                            version: DRIVER_VERSION,
                            nativeInterface: NATIVE_INTERFACE_VERSION,
                            target,
                            files,
                        },
                        null,
                        2,
                    ) + '\n',
            });
        },
    };
}
