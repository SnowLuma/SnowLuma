import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { build } from 'vite';
import { sqliteBuildPlugin } from '../src/vite';
import { prebuildFiles } from '../src/layout';

it('runs bundled SQLite from a release directory with no installed dependencies', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-release-'));

    try {
        const target = `${process.platform}-${process.arch}`;
        await build({
            configFile: false,
            logLevel: 'silent',
            plugins: [sqliteBuildPlugin(target)],
            build: {
                target: 'node24',
                outDir: directory,
                emptyOutDir: false,
                minify: false,
                lib: {
                    entry: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
                    formats: ['es'],
                    fileName: () => 'database.mjs',
                },
                rollupOptions: {
                    external: isBuiltin,
                },
            },
        });
        const probe = path.join(directory, 'probe.mjs');
        await fs.writeFile(
            probe,
            `
      import { SqliteDatabase } from './database.mjs';
      const db = new SqliteDatabase(':memory:');
      await db.exec('CREATE TABLE records (value TEXT)');
      await db.prepare('INSERT INTO records VALUES (?)').run('packaged');
      const row = await db.prepare('SELECT value FROM records').get();
      await db.close();
      if (row.value !== 'packaged') throw new Error('packaged SQLite round trip failed');
      console.log('packaged SQLite ok');
    `,
        );
        const { stdout } = await promisify(execFile)(process.execPath, [probe], {
            cwd: os.tmpdir(),
        });
        expect(stdout.trim()).toBe('packaged SQLite ok');
        const manifest = JSON.parse(
            await fs.readFile(path.join(directory, 'native/sqlite/manifest.json'), 'utf8'),
        );
        expect(manifest).toMatchObject({
            package: '@appthreat/sqlite3',
            version: '9.1.0',
            nativeInterface: 1,
            target,
        });
        const bundle = await fs.readFile(path.join(directory, 'database.mjs'), 'utf8');
        expect(bundle).not.toContain('node-gyp-build');
        expect(bundle).not.toContain("resolve('@appthreat/sqlite3/package.json')");

        // Even with dependencies available in the caller's cwd, a broken release
        // cannot silently load a development binary or a different local build.
        for (const file of prebuildFiles(target)) {
            await fs.unlink(path.join(directory, 'native/sqlite/prebuilds', file));
        }

        await expect(
            promisify(execFile)(process.execPath, [probe], { cwd: process.cwd() }),
        ).rejects.toMatchObject({
            stderr: expect.stringContaining('Failed to load SQLite native addon:'),
        });
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}, 30_000);

it.each(['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'])(
    'packages %s using the same installed prebuild dependency',
    async (target) => {
        const result = await build({
            configFile: false,
            logLevel: 'silent',
            plugins: [sqliteBuildPlugin(target)],
            build: {
                target: 'node24',
                write: false,
                minify: false,
                lib: {
                    entry: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
                    formats: ['es'],
                },
                rollupOptions: { external: isBuiltin },
            },
        });
        const bundle = Array.isArray(result) ? result[0] : result;

        if (!('output' in bundle)) {
            throw new Error('Expected one release bundle');
        }

        const names = bundle.output.map((file) => file.fileName);
        expect(names.filter((name) => name.endsWith('.node')).sort()).toEqual(
            prebuildFiles(target)
                .map((file) => `native/sqlite/prebuilds/${file}`)
                .sort(),
        );
        expect(names).toContain('native/sqlite/LICENSE.sqlite3');
        expect(names).toContain('native/sqlite/manifest.json');

        for (const chunk of bundle.output) {
            if (chunk.type === 'chunk') {
                expect(
                    Object.keys(chunk.modules).some((file) => file.includes('/node_modules/')),
                ).toBe(false);
            }
        }
    },
);
