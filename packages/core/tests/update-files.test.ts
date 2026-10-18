import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPendingUpdate, exists, readManifest, updateDirectory } from '../src/update/files';
import { releaseFixture } from './helpers/update-fixture';

vi.mock('node:fs/promises', async (original) => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual, rename: vi.fn(actual.rename) };
});

let root: string;
let staging: string;
beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'snowluma-update-test-'));
    await releaseFixture(root, '1.0.0', 'win32-x64', 'old.mjs');
    staging = await updateDirectory(root);
    await releaseFixture(path.join(staging, 'pending/payload'), '2.0.0', 'win32-x64', 'new.mjs');
});
afterEach(async () => {
    vi.mocked(fs.rename).mockReset();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.rename).mockImplementation(actual.rename);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(staging, { recursive: true, force: true });
});

describe('staged updates', () => {
    it.each(['02.0.0', '2.0.0-rc.01', '2.0.0-rc_1', '2.0.0+build..1'])(
        'rejects invalid manifest versions before replacing files: %s',
        async (version) => {
            const payload = path.join(staging, 'pending/payload');
            const manifest = await readManifest(payload);
            await fs.writeFile(
                path.join(payload, 'release.json'),
                JSON.stringify({ ...manifest, version }),
            );
            await expect(applyPendingUpdate(root)).rejects.toThrow('清单无效');
            expect((await readManifest(root)).version).toBe('1.0.0');
        },
    );

    it('accepts prerelease identifiers and build metadata in manifests', async () => {
        const payload = path.join(staging, 'pending/payload');
        const manifest = await readManifest(payload);
        const version = '2.0.0-rc.10+build.01';
        await fs.writeFile(
            path.join(payload, 'release.json'),
            JSON.stringify({ ...manifest, version }),
        );
        expect((await readManifest(payload)).version).toBe(version);
    });

    it('stages outside the installation and only renames replacements on the destination filesystem', async () => {
        expect(path.dirname(staging)).toBe(os.tmpdir());
        expect(staging.startsWith(root + path.sep)).toBe(false);
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
            if (
                path.dirname(String(destination)) === root &&
                path.dirname(String(source)) !== root
            ) {
                throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' });
            }

            return actual.rename(source, destination);
        });
        expect(await applyPendingUpdate(root)).toBe('2.0.0');
        expect(await exists(path.join(root, '.update-install'))).toBe(false);
        expect(await exists(staging)).toBe(false);
    });

    it('rejects an entry point replaced by a directory before touching the installed entry point', async () => {
        const entry = path.join(staging, 'pending/payload/index.mjs');
        await fs.rm(entry);
        await fs.mkdir(entry);
        await expect(applyPendingUpdate(root)).rejects.toThrow('文件类型无效');
        expect(await fs.readFile(path.join(root, 'index.mjs'), 'utf8')).toBe('1.0.0');
    });

    it('cleans a download interrupted before staging', async () => {
        await fs.mkdir(path.join(staging, 'downloading'));
        await fs.writeFile(path.join(staging, 'downloading/archive'), 'partial');
        await fs.rm(path.join(staging, 'pending'), { recursive: true });
        expect(await applyPendingUpdate(root)).toBeNull();
        expect(await exists(staging)).toBe(false);
    });

    it('replaces program files, removes obsolete chunks and preserves user data and Node', async () => {
        for (const file of [
            'config/runtime.json',
            'data/messages.db',
            'logs/current.log',
            'tmp/unrelated',
            'node.exe',
            'custom.mjs',
        ]) {
            await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
            await fs.writeFile(path.join(root, file), 'keep');
        }

        expect(await applyPendingUpdate(root)).toBe('2.0.0');
        expect((await readManifest(root)).version).toBe('2.0.0');
        expect(await fs.readFile(path.join(root, 'native/binding.node'), 'utf8')).toBe('2.0.0');
        expect(await exists(path.join(root, 'old.mjs'))).toBe(false);
        expect(await exists(path.join(root, 'new.mjs'))).toBe(true);

        for (const file of [
            'config/runtime.json',
            'data/messages.db',
            'logs/current.log',
            'tmp/unrelated',
            'node.exe',
            'custom.mjs',
        ]) {
            expect(await fs.readFile(path.join(root, file), 'utf8')).toBe('keep');
        }

        expect(await fs.readdir(path.join(root, 'tmp'))).toEqual(['unrelated']);
        expect(await applyPendingUpdate(root)).toBeNull();
    });

    it('only installs files declared by the release manifest', async () => {
        await fs.writeFile(path.join(staging, 'pending/payload/unlisted.mjs'), 'ignored');
        expect(await applyPendingUpdate(root)).toBe('2.0.0');
        expect(await exists(path.join(root, 'unlisted.mjs'))).toBe(false);
    });

    it('restores the entire old release after a replacement fails, then retries on next startup', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        let failed = false;
        vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
            if (!failed && destination === path.join(root, 'client')) {
                failed = true;
                throw new Error('file locked');
            }

            return actual.rename(source, destination);
        });
        await expect(applyPendingUpdate(root)).rejects.toThrow('file locked');
        expect((await readManifest(root)).version).toBe('1.0.0');
        expect(await fs.readFile(path.join(root, 'app.mjs'), 'utf8')).toBe('1.0.0');
        expect(await fs.readFile(path.join(root, 'client/index.html'), 'utf8')).toBe('1.0.0');
        expect(await exists(path.join(root, 'new.mjs'))).toBe(false);
        expect(await exists(path.join(staging, 'pending/payload'))).toBe(true);
        await expect(applyPendingUpdate(root)).resolves.toBe('2.0.0');
    });

    it('recovers an interrupted transaction before retrying', async () => {
        const current = await readManifest(root);
        const next = await readManifest(path.join(staging, 'pending/payload'));
        const backup = path.join(staging, 'pending/backup');
        await fs.mkdir(backup);

        for (const entry of current.entries) {
            await fs.cp(path.join(root, entry), path.join(backup, entry), { recursive: true });
        }

        await fs.writeFile(
            path.join(staging, 'pending/transaction.json'),
            JSON.stringify({
                entries: [...new Set([...current.entries, ...next.entries])],
                original: current.entries,
            }),
        );
        await fs.writeFile(path.join(root, 'app.mjs'), 'interrupted');
        await fs.rm(path.join(root, 'native'), { recursive: true });
        await fs.writeFile(path.join(root, 'new.mjs'), 'partial');
        // Fail before installation so we can inspect the recovered release.
        const entry = path.join(staging, 'pending/payload/index.mjs');
        await fs.rm(entry);
        await fs.mkdir(entry);
        await expect(applyPendingUpdate(root)).rejects.toThrow('文件类型无效');
        expect(await fs.readFile(path.join(root, 'index.mjs'), 'utf8')).toBe('1.0.0');
        expect(await fs.readFile(path.join(root, 'app.mjs'), 'utf8')).toBe('1.0.0');
        expect(await fs.readFile(path.join(root, 'native/binding.node'), 'utf8')).toBe('1.0.0');
        expect(await exists(path.join(root, 'new.mjs'))).toBe(false);
        await fs.rm(entry, { recursive: true });
        await fs.writeFile(entry, '2.0.0');
        expect(await applyPendingUpdate(root)).toBe('2.0.0');
    });

    it('cleans an already committed transaction without restoring its backup', async () => {
        await fs.rename(path.join(staging, 'pending'), path.join(staging, 'completed'));
        expect(await applyPendingUpdate(root)).toBeNull();
        expect(await exists(staging)).toBe(false);
    });

    it.each(['config', '../outside', 'node.exe', 'data', 'C:/outside'])(
        'rejects a manifest owning %s',
        async (entry) => {
            const payload = path.join(staging, 'pending/payload');
            const manifest = await readManifest(payload);
            manifest.entries.push(entry);
            await fs.writeFile(path.join(payload, 'release.json'), JSON.stringify(manifest));
            await expect(applyPendingUpdate(root)).rejects.toThrow('清单无效');
            expect((await readManifest(root)).version).toBe('1.0.0');
        },
    );

    it('rejects a release for a different platform before replacing anything', async () => {
        const payload = path.join(staging, 'pending/payload');
        await fs.rm(payload, { recursive: true });
        await releaseFixture(payload, '2.0.0', 'linux-x64');
        await expect(applyPendingUpdate(root)).rejects.toThrow('平台不匹配');
        expect((await readManifest(root)).version).toBe('1.0.0');
    });
});
