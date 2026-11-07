import { updateDirectory } from '../src/update/files';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdateService } from '../src/update/service';
import { updateRoutes } from '../src/webui/update-routes';
import { releaseFixture } from './helpers/update-fixture';

vi.mock('node:fs/promises', async (original) => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual, access: vi.fn(actual.access), rename: vi.fn(actual.rename) };
});

let root: string;
let staging: string;
// Real filesystem staging can exceed waitFor's default one-second budget under load.
const fileSystemWait = { timeout: 5_000 };
beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snowluma-update-service-'));
    await releaseFixture(root, '1.0.0');
    staging = await updateDirectory(root);
});
afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(access).mockReset().mockImplementation(actual.access);
    vi.mocked(rename).mockReset().mockImplementation(actual.rename);
    await rm(root, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
});

describe('update service', { timeout: 15_000 }, () => {
    it('stages a single download, survives a service reload and leaves running files alone', async () => {
        let finish!: () => void;
        const wait = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const download = vi.fn(async (directory: string, version: string, target: string) => {
            await wait;
            await releaseFixture(path.join(directory, 'payload'), version, target);
            await writeFile(path.join(directory, 'archive'), 'archive');
        });
        const service = await createUpdateService(root, '1.0.0', {
            download,
            restartAvailable: true,
        });
        service.start('2.0.0');
        expect(service.status()).toEqual({
            current: '1.0.0',
            phase: 'downloading',
            version: '2.0.0',
        });
        expect(() => service.start('2.0.0')).toThrow('正在进行');
        finish();
        await vi.waitFor(() => expect(service.status().phase).toBe('ready'), fileSystemWait);
        expect(download).toHaveBeenCalledOnce();
        expect(await readdir(path.join(staging, 'pending'))).toEqual(['payload']);
        const reloaded = await createUpdateService(root, '1.0.0', {
            download,
            restartAvailable: true,
        });
        expect(reloaded.status()).toEqual({ current: '1.0.0', phase: 'ready', version: '2.0.0' });
        reloaded.restart();
        expect(reloaded.status().phase).toBe('restarting');
        expect(() => reloaded.restart()).toThrow('尚未就绪');
    });

    it('cleans a failed download and allows retry', async () => {
        const download = vi.fn(async (directory: string) => {
            await writeFile(path.join(directory, 'archive'), 'partial');
            throw new Error('connection reset');
        });
        const service = await createUpdateService(root, '1.0.0', {
            download,
            restartAvailable: true,
        });
        service.start('2.0.0');
        await vi.waitFor(
            () =>
                expect(service.status()).toEqual({
                    current: '1.0.0',
                    phase: 'error',
                    message: 'connection reset',
                }),
            fileSystemWait,
        );
        expect(await readdir(staging)).toEqual([]);
        expect(() => service.start('2.0.0')).not.toThrow();
        await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2), fileSystemWait);
        await vi.waitFor(() => expect(service.status().phase).toBe('error'), fileSystemWait);
    });

    it.each(['02.0.0', '2.0.0\n', '../../outside', null])(
        'rejects invalid version %s',
        async (version) => {
            const download = vi.fn();
            const service = await createUpdateService(root, '1.0.0', {
                download,
                restartAvailable: true,
            });
            expect(() => service.start(version)).toThrow('有效的版本号');
            expect(download).not.toHaveBeenCalled();
        },
    );

    it('downloads stable versions with build metadata without dropping the tag suffix', async () => {
        const download = vi.fn(async (directory: string, version: string, target: string) => {
            await releaseFixture(path.join(directory, 'payload'), version, target);
            await writeFile(path.join(directory, 'archive'), 'archive');
        });
        const service = await createUpdateService(root, '1.0.0', {
            download,
            restartAvailable: true,
        });
        service.start('2.0.0+build.01');
        await vi.waitFor(() => expect(service.status().phase).toBe('ready'), fileSystemWait);
        expect(download).toHaveBeenCalledWith(expect.any(String), '2.0.0+build.01', 'win32-x64');
        expect(service.status()).toMatchObject({ version: '2.0.0+build.01' });
    });

    it('does not enable updates for a source checkout', async () => {
        const service = await createUpdateService(undefined, '1.0.0');
        expect(service.status().phase).toBe('unavailable');
        expect(() => service.start('2.0.0')).toThrow('发行包');
        expect(() => service.restart()).toThrow('尚未就绪');
    });

    it.each(['1.0.0', '1.0.0+build.2', '2.0.0-rc.1'])(
        'allows reinstalling the current version and selecting a prerelease: %s',
        async (version) => {
            const download = vi.fn(async (directory: string, selected: string, target: string) => {
                await releaseFixture(path.join(directory, 'payload'), selected, target);
                await writeFile(path.join(directory, 'archive'), 'archive');
            });
            const service = await createUpdateService(root, '1.0.0', {
                download,
                restartAvailable: true,
            });
            service.start(version);
            await vi.waitFor(
                () => expect(service.status()).toMatchObject({ phase: 'ready', version }),
                fileSystemWait,
            );
            expect(download).toHaveBeenCalledWith(expect.any(String), version, 'win32-x64');
        },
    );

    it('requires explicit confirmation for downgrades, including prereleases of the current version', async () => {
        const download = vi.fn(async (directory: string, version: string, target: string) => {
            await releaseFixture(path.join(directory, 'payload'), version, target);
            await writeFile(path.join(directory, 'archive'), 'archive');
        });
        const service = await createUpdateService(root, '1.0.0', {
            download,
            restartAvailable: true,
        });
        expect(() => service.start('0.9.0')).toThrow('降级需要明确确认');
        expect(() => service.start('0.9.0', { allowDowngrade: false })).toThrow('降级需要明确确认');
        expect(() => service.start('1.0.0-rc.1')).toThrow('降级需要明确确认');
        expect(download).not.toHaveBeenCalled();
        service.start('0.9.0', { allowDowngrade: true });
        await vi.waitFor(
            () => expect(service.status()).toMatchObject({ phase: 'ready', version: '0.9.0' }),
            fileSystemWait,
        );
    });

    it.each(['true', 1, null])(
        'rejects a malformed downgrade confirmation: %s',
        async (allowDowngrade) => {
            const download = vi.fn();
            const service = await createUpdateService(root, '1.0.0', {
                download,
                restartAvailable: true,
            });
            expect(() => service.start('2.0.0', { allowDowngrade })).toThrow(
                'allowDowngrade 必须是布尔值',
            );
            expect(download).not.toHaveBeenCalled();
            expect(service.status().phase).toBe('idle');
        },
    );

    it('enables container updates when the runtime is writable and a restart launcher is available', async () => {
        vi.stubEnv('container', 'docker');
        const service = await createUpdateService(root, '1.0.0', { restartAvailable: true });
        expect(service.status()).toEqual({ current: '1.0.0', phase: 'idle' });
        expect((await readdir(root)).some((entry) => entry.startsWith('.update-check-'))).toBe(
            false,
        );
    });

    it('does not advertise an update without a controlled restart launcher', async () => {
        const service = await createUpdateService(root, '1.0.0', { restartAvailable: false });
        expect(service.status()).toMatchObject({
            phase: 'unavailable',
            message: expect.stringContaining('启动器'),
        });
        expect(() => service.start('2.0.0')).toThrow('启动器');
    });

    it('reports inaccessible runtime files without disabling the WebUI', async () => {
        vi.mocked(access).mockRejectedValueOnce(
            Object.assign(new Error('runtime denied'), { code: 'EACCES' }),
        );
        const service = await createUpdateService(root, '1.0.0', { restartAvailable: true });
        expect(service.status()).toMatchObject({
            phase: 'unavailable',
            message: expect.stringContaining('runtime denied'),
        });
        expect(() => service.start('2.0.0')).toThrow('读写权限');
    });

    it('detects a read-only runtime even when permission bits appear writable and cleans the probe', async () => {
        vi.mocked(rename).mockRejectedValueOnce(
            Object.assign(new Error('read-only filesystem'), { code: 'EROFS' }),
        );
        const service = await createUpdateService(root, '1.0.0', { restartAvailable: true });
        expect(service.status()).toMatchObject({
            phase: 'unavailable',
            message: expect.stringContaining('read-only filesystem'),
        });
        expect((await readdir(root)).some((entry) => entry.startsWith('.update-check-'))).toBe(
            false,
        );
    });

    it('rechecks write access before downloading and reports a permission change', async () => {
        const download = vi.fn();
        const service = await createUpdateService(root, '1.0.0', {
            download,
            restartAvailable: true,
        });
        vi.mocked(access).mockRejectedValueOnce(
            Object.assign(new Error('mount became read-only'), { code: 'EROFS' }),
        );
        service.start('2.0.0');
        await vi.waitFor(
            () =>
                expect(service.status()).toMatchObject({
                    phase: 'error',
                    message: expect.stringContaining('mount became read-only'),
                }),
            fileSystemWait,
        );
        expect(download).not.toHaveBeenCalled();
    });

    it('restarts only after the HTTP response has finished', async () => {
        await releaseFixture(path.join(staging, 'pending/payload'), '2.0.0');
        const service = await createUpdateService(root, '1.0.0', { restartAvailable: true });
        const restart = vi.fn();
        const outgoing = new EventEmitter();
        const app = updateRoutes(service, restart);
        const response = await app.request('/restart', { method: 'POST' }, { outgoing });
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({ phase: 'restarting' });
        expect(restart).not.toHaveBeenCalled();
        outgoing.emit('finish');
        expect(restart).toHaveBeenCalledOnce();
    });

    it.each(['{}', 'not json'])('rejects an invalid download request: %s', async (body) => {
        const service = await createUpdateService(root, '1.0.0', { restartAvailable: true });
        const app = updateRoutes(service, vi.fn());
        const response = await app.request('/download', { method: 'POST', body });
        expect(response.status).toBe(400);
        expect(service.status().phase).toBe('idle');
    });
});
