import { updateDirectory } from '../src/update/files';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdateService } from '../src/update/service';
import { updateRoutes } from '../src/webui/update-routes';
import { releaseFixture } from './helpers/update-fixture';

let root: string;
let staging: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snowluma-update-service-'));
    await releaseFixture(root, '1.0.0');
    staging = await updateDirectory(root);
});
afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
});

describe('update service', () => {
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
        const service = await createUpdateService(root, '1.0.0', { download, isContainer: false });
        service.start('2.0.0');
        expect(service.status()).toEqual({
            current: '1.0.0',
            phase: 'downloading',
            version: '2.0.0',
        });
        expect(() => service.start('2.0.0')).toThrow('正在进行');
        finish();
        await vi.waitFor(() => expect(service.status().phase).toBe('ready'));
        expect(download).toHaveBeenCalledOnce();
        expect(await readdir(path.join(staging, 'pending'))).toEqual(['payload']);
        const reloaded = await createUpdateService(root, '1.0.0', { download, isContainer: false });
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
        const service = await createUpdateService(root, '1.0.0', { download, isContainer: false });
        service.start('2.0.0');
        await vi.waitFor(() =>
            expect(service.status()).toEqual({
                current: '1.0.0',
                phase: 'error',
                message: 'connection reset',
            }),
        );
        expect(await readdir(staging)).toEqual([]);
        expect(() => service.start('2.0.0')).not.toThrow();
        await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(service.status().phase).toBe('error'));
    });

    it.each([
        '1.0.0',
        '0.9.0',
        '2.0.0-rc.1',
        '02.0.0',
        '2.0.0\n',
        '1.0.0+build.2',
        '../../outside',
        null,
    ])('rejects invalid or older version %s', async (version) => {
        const download = vi.fn();
        const service = await createUpdateService(root, '1.0.0', {
            download,
            isContainer: false,
        });
        expect(() => service.start(version)).toThrow('正式版本');
        expect(download).not.toHaveBeenCalled();
    });

    it('downloads stable versions with build metadata without dropping the tag suffix', async () => {
        const download = vi.fn(async (directory: string, version: string, target: string) => {
            await releaseFixture(path.join(directory, 'payload'), version, target);
            await writeFile(path.join(directory, 'archive'), 'archive');
        });
        const service = await createUpdateService(root, '1.0.0', { download, isContainer: false });
        service.start('2.0.0+build.01');
        await vi.waitFor(() => expect(service.status().phase).toBe('ready'));
        expect(download).toHaveBeenCalledWith(expect.any(String), '2.0.0+build.01', 'win32-x64');
        expect(service.status()).toMatchObject({ version: '2.0.0+build.01' });
    });

    it('does not enable updates for a source checkout', async () => {
        const service = await createUpdateService(undefined, '1.0.0');
        expect(service.status().phase).toBe('unavailable');
        expect(() => service.start('2.0.0')).toThrow('发行包');
        expect(() => service.restart()).toThrow('尚未就绪');
    });

    it('does not update container image layers', async () => {
        const service = await createUpdateService(root, '1.0.0', { isContainer: true });
        expect(service.status()).toMatchObject({ phase: 'unavailable', message: '请更新容器镜像' });
    });

    it('restarts only after the HTTP response has finished', async () => {
        await releaseFixture(path.join(staging, 'pending/payload'), '2.0.0');
        const service = await createUpdateService(root, '1.0.0', { isContainer: false });
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
        const service = await createUpdateService(root, '1.0.0', { isContainer: false });
        const app = updateRoutes(service, vi.fn());
        const response = await app.request('/download', { method: 'POST', body });
        expect(response.status).toBe(400);
        expect(service.status().phase).toBe('idle');
    });
});
