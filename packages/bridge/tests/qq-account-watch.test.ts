import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@snowluma/common/logger';
import { watchAccountFiles } from '../src/qq-account/watch';

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof fs>();
    return { ...actual, watch: vi.fn(actual.watch) };
});

let root: string;
const subscriptions: Array<() => void> = [];

beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snowluma-account-watch-'));
});

afterEach(async () => {
    for (const stop of subscriptions.splice(0)) {
        stop();
    }

    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

function subscribe(dbPaths = [path.join(root, 'login.db')]) {
    const changed = vi.fn();
    const log = createLogger('AccountWatchTest');
    const warning = vi.spyOn(log, 'warn');
    const stop = watchAccountFiles(dbPaths, changed, log);
    subscriptions.push(stop);
    return { changed, stop, warning };
}

describe('account file changes', () => {
    it('coalesces login database and WAL changes while ignoring message data and SHM', async () => {
        const dbPath = path.join(root, 'login.db');
        const { changed } = subscribe([dbPath, dbPath]);
        expect(fs.watch).toHaveBeenCalledTimes(1);
        await writeFile(dbPath, 'login');
        await writeFile(`${dbPath}-wal`, 'wal');
        await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
        await writeFile(path.join(root, 'nt_msg.db'), 'message');
        await writeFile(`${dbPath}-shm`, 'shared memory');
        await delay(350);
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it('observes database replacement and WAL recreation', async () => {
        const dbPath = path.join(root, 'login.db');
        await writeFile(dbPath, 'initial');
        const { changed } = subscribe();
        await writeFile(path.join(root, 'replacement'), 'replacement');
        await rename(path.join(root, 'replacement'), dbPath);
        await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
        await writeFile(dbPath, 'updated');
        await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
        await writeFile(`${dbPath}-wal`, 'wal');
        await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
        await rm(`${dbPath}-wal`);
        await writeFile(`${dbPath}-wal`, 'new wal');
        await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(4));
    });

    it('starts watching login data created after QQ process discovery', async () => {
        const dbPath = path.join(root, 'QQ', 'global', 'nt_db', 'login.db');
        const { changed } = subscribe([dbPath]);
        await mkdir(path.dirname(dbPath), { recursive: true });
        await writeFile(dbPath, 'initial');
        await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
        await writeFile(`${dbPath}-wal`, 'login');
        await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    });

    it('closes watchers and cancels pending notifications on disposal', async () => {
        const { changed, stop } = subscribe();
        await writeFile(path.join(root, 'login.db'), 'initial');
        await delay(30);
        stop();
        await writeFile(path.join(root, 'login.db'), 'later');
        await delay(350);
        expect(changed).not.toHaveBeenCalled();
    });

    it('reports watch failures without starting a polling fallback', async () => {
        vi.mocked(fs.watch).mockImplementationOnce(() => {
            throw Object.assign(new Error('access denied'), { code: 'EACCES' });
        });
        const { changed, warning } = subscribe();
        expect(warning).toHaveBeenCalledWith(
            'account watch failed: path=%s err=%s',
            path.join(root, 'login.db'),
            'access denied',
        );
        await delay(350);
        expect(fs.watch).toHaveBeenCalledTimes(1);
        expect(changed).not.toHaveBeenCalled();
    });

    it('reports asynchronous watch errors and closes the failed watcher', () => {
        const { changed, warning } = subscribe();
        const watcher = vi.mocked(fs.watch).mock.results[0]!.value;
        const close = vi.spyOn(watcher, 'close');
        watcher.emit('error', new Error('watch unavailable'));
        expect(close).toHaveBeenCalledOnce();
        expect(warning).toHaveBeenCalledWith(
            'account watch failed: path=%s err=%s',
            path.join(root, 'login.db'),
            'watch unavailable',
        );
        expect(changed).not.toHaveBeenCalled();
    });
});
