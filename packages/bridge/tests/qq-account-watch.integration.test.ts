import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { watchAccountFiles } from '../src/qq-account/watch';

// Keep native filesystem coverage aligned with qqDataRootsForPid's supported platforms.
// macOS is only a development host here: fs.watch() can return before FSEvents
// registration, losing immediate writes. Deterministic logic tests run on every OS.
describe.skipIf(process.platform !== 'win32' && process.platform !== 'linux')(
    'account file changes on supported filesystems',
    () => {
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
        });

        function subscribe(dbPaths = [path.join(root, 'login.db')]) {
            const changed = vi.fn();
            subscriptions.push(watchAccountFiles(dbPaths, changed));
            return changed;
        }

        it('observes database and WAL changes while ignoring message data and SHM', async () => {
            const dbPath = path.join(root, 'login.db');
            const changed = subscribe([dbPath, dbPath]);
            await writeFile(dbPath, 'login');
            await vi.waitFor(() => expect(changed).toHaveBeenCalled());
            const afterDatabase = changed.mock.calls.length;
            await writeFile(`${dbPath}-wal`, 'wal');
            await vi.waitFor(() =>
                expect(changed.mock.calls.length).toBeGreaterThan(afterDatabase),
            );
            const afterWal = changed.mock.calls.length;
            await writeFile(path.join(root, 'nt_msg.db'), 'message');
            await writeFile(`${dbPath}-shm`, 'shared memory');
            await delay(350);
            expect(changed).toHaveBeenCalledTimes(afterWal);
        });

        it('observes database replacement and WAL recreation', async () => {
            const dbPath = path.join(root, 'login.db');
            await writeFile(dbPath, 'initial');
            const changed = subscribe();
            await writeFile(path.join(root, 'replacement'), 'replacement');
            await rename(path.join(root, 'replacement'), dbPath);
            await vi.waitFor(() => expect(changed).toHaveBeenCalled());
            const afterReplacement = changed.mock.calls.length;
            await writeFile(dbPath, 'updated');
            await vi.waitFor(() =>
                expect(changed.mock.calls.length).toBeGreaterThan(afterReplacement),
            );
            const afterUpdate = changed.mock.calls.length;
            await writeFile(`${dbPath}-wal`, 'wal');
            await vi.waitFor(() => expect(changed.mock.calls.length).toBeGreaterThan(afterUpdate));
            const afterWal = changed.mock.calls.length;
            await rm(`${dbPath}-wal`);
            await writeFile(`${dbPath}-wal`, 'new wal');
            await vi.waitFor(() => expect(changed.mock.calls.length).toBeGreaterThan(afterWal));
        });

        it('starts watching login data created after QQ process discovery', async () => {
            const dbPath = path.join(root, 'QQ', 'global', 'nt_db', 'login.db');
            const changed = subscribe([dbPath]);
            await mkdir(path.dirname(dbPath), { recursive: true });
            await writeFile(dbPath, 'initial');
            await vi.waitFor(() => expect(changed).toHaveBeenCalled());
            const afterDatabase = changed.mock.calls.length;
            await writeFile(`${dbPath}-wal`, 'login');
            await vi.waitFor(() =>
                expect(changed.mock.calls.length).toBeGreaterThan(afterDatabase),
            );
        });
    },
);
