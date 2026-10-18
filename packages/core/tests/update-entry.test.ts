import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, loadConfigFromFile } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exists, updateDirectory } from '../src/update/files';
import { releaseFixture } from './helpers/update-fixture';

let compiled: string;
let root: string;
let staging: string;

beforeAll(async () => {
    compiled = await mkdtemp(path.join(os.tmpdir(), 'snowluma-entry-build-'));
    const loaded = await loadConfigFromFile(
        { command: 'build', mode: 'production' },
        fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    );

    if (!loaded) {
        throw new Error('missing core build config');
    }

    const config = loaded.config;
    const startup = fileURLToPath(new URL('../src/update/startup.ts', import.meta.url)).replaceAll(
        '\\',
        '/',
    );
    const files = fileURLToPath(new URL('../src/update/files.ts', import.meta.url)).replaceAll(
        '\\',
        '/',
    );
    const fixture = path.join(compiled, 'fixture.ts').replaceAll('\\', '/');
    await writeFile(fixture, '');

    for (const version of ['1.0.0', '2.0.0']) {
        let loadedFixture = false;
        await build({
            ...config,
            configFile: false,
            logLevel: 'silent',
            plugins: [
                {
                    name: 'fixture-application',
                    enforce: 'pre',
                    load(id) {
                        if (id.replaceAll('\\', '/') !== fixture) {
                            return null;
                        }

                        loadedFixture = true;
                        return `
                        import fs from 'node:fs';
                        import path from 'node:path';
                        import { fileURLToPath } from 'node:url';
                        import { RESTART_EXIT_CODE, runApplication } from '${startup}';
                        import { updateDirectory } from '${files}';
                        const root = path.dirname(fileURLToPath(import.meta.url));
                        if (!process.env.SNOWLUMA_UPDATE_ROOT) {
                            await runApplication(root);
                        } else {
                        const version = '${version}';
                        if (process.env.UPDATE_TEST_MODE === 'restart' && version === '1.0.0') {
                            const staging = await updateDirectory(root);
                            fs.cpSync(path.join(root, 'candidate'), path.join(staging, 'pending'), {recursive:true});
                            fs.writeFileSync(path.join(root, 'old-pid'), String(process.pid));
                            process.exit(RESTART_EXIT_CODE);
                        }
                        if (process.env.UPDATE_TEST_MODE === 'fail') {
                            console.error('startup failed');
                            process.exit(1);
                        }
                        let oldAlive = false;
                        if (process.platform === 'win32' && fs.existsSync(path.join(root, 'old-pid'))) {
                            try { process.kill(Number(fs.readFileSync(path.join(root, 'old-pid'), 'utf8')), 0); oldAlive = true; }
                            catch (error) { if (error.code !== 'ESRCH') throw error; }
                        }
                        console.log(JSON.stringify({version, node:process.execPath, cwd:process.cwd(), args:process.argv.slice(2), oldAlive}));
                        process.exit(0);
                        }
                    `;
                    },
                    generateBundle(_options, bundle) {
                        expect(loadedFixture).toBe(true);
                        const entry = bundle['index.mjs'];
                        expect(entry.type).toBe('chunk');

                        if (entry.type !== 'chunk') {
                            throw new Error('missing entry');
                        }

                        expect(
                            entry.imports.filter(
                                (id) => !builtinModules.includes(id) && !id.startsWith('node:'),
                            ),
                        ).toEqual([]);
                        expect(entry.dynamicImports).toEqual([]);
                    },
                },
            ],
            build: {
                ...config.build,
                outDir: path.join(compiled, version),
                lib: { entry: { index: fixture }, formats: ['es'], fileName: () => 'index.mjs' },
            },
        });
    }
});

afterAll(async () => {
    await rm(compiled, { recursive: true, force: true });
});
beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snowluma-entry-test-'));
    staging = await updateDirectory(root);
    await releaseFixture(root, '1.0.0');
    await cp(path.join(compiled, '1.0.0/index.mjs'), path.join(root, 'index.mjs'));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
});

function run(mode = '', args: string[] = []) {
    return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(root, 'index.mjs'), ...args], {
            cwd: os.tmpdir(),
            stdio: 'pipe',
            windowsHide: true,
            env: { ...process.env, UPDATE_TEST_MODE: mode },
        });
        let output = '';
        child.stdout.on('data', (data: Buffer) => {
            output += data.toString();
        });
        child.stderr.on('data', (data: Buffer) => {
            output += data.toString();
        });
        child.once('error', reject);
        child.once('close', (code) => {
            resolve({ code, output });
        });
    });
}

async function candidate(directory: string) {
    await releaseFixture(path.join(directory, 'payload'), '2.0.0');
    await cp(path.join(compiled, '2.0.0/index.mjs'), path.join(directory, 'payload/index.mjs'));
}

describe('packaged startup', () => {
    it('preserves the exact Node executable, arguments and working directory', async () => {
        const result = await run('', ['value with spaces']);
        expect(result.code, result.output).toBe(0);
        expect(JSON.parse(result.output)).toEqual({
            version: '1.0.0',
            node: process.execPath,
            cwd: os.tmpdir(),
            args: ['value with spaces'],
            oldAlive: false,
        });
    });

    it('waits for the old process to exit, applies the release, then executes the new code', async () => {
        await candidate(path.join(root, 'candidate'));
        const result = await run('restart', ['kept']);
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('已更新至 v2.0.0');
        expect(JSON.parse(result.output.trim().split('\n').at(-1)!)).toMatchObject({
            version: '2.0.0',
            args: ['kept'],
            oldAlive: false,
        });
        expect(JSON.parse(await readFile(path.join(root, 'release.json'), 'utf8')).version).toBe(
            '2.0.0',
        );
        expect(await exists(staging)).toBe(false);
    });

    it('applies an already staged update on ordinary startup', async () => {
        await candidate(path.join(staging, 'pending'));
        const result = await run();
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('"version":"2.0.0"');
        expect(result.output).not.toContain('"version":"1.0.0"');
    });

    it('propagates an application failure without restarting it', async () => {
        expect(await run('fail')).toEqual({ code: 1, output: 'startup failed\n' });
    });
});
