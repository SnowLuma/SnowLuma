import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FSWatcher, WatchListener } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@snowluma/common/logger';
import { watchAccountChangesForPids, watchAccountFiles } from '../src/qq-account/watch';

const files = vi.hoisted(() => ({
    watch: vi.fn<
        (
            directory: string,
            options: { persistent: boolean },
            listener: WatchListener<string>,
        ) => FSWatcher
    >(),
}));

vi.mock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    watch: files.watch,
}));

class TestWatcher extends EventEmitter implements FSWatcher {
    // Keep callbacks reachable after close to exercise queued, stale events.
    close = vi.fn();
    ref() {
        return this;
    }
    unref() {
        return this;
    }
}

const root = path.resolve('account-watch-fixture');
const directories = new Set<string>();
const watchers: TestWatcher[] = [];
const subscriptions: Array<() => void> = [];
const platform = process.platform;

beforeEach(() => {
    vi.useFakeTimers();
    directories.add(root);
    files.watch.mockImplementation((directory, _options, listener) => {
        if (!directories.has(directory)) {
            throw Object.assign(new Error('directory missing'), { code: 'ENOENT' });
        }

        const watcher = new TestWatcher();
        watcher.on('change', listener);
        watchers.push(watcher);
        return watcher;
    });
});

afterEach(() => {
    for (const stop of subscriptions.splice(0)) {
        stop();
    }

    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    watchers.length = 0;
    directories.clear();
    files.watch.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function subscribe(dbPaths = [path.join(root, 'login.db')]) {
    const changed = vi.fn();
    const log = createLogger('AccountWatchTest');
    const warning = vi.spyOn(log, 'warn');
    const stop = watchAccountFiles(dbPaths, changed, log);
    subscriptions.push(stop);
    return { changed, stop, warning };
}

// Native filesystem delivery is covered separately on the production platforms.
// These tests control event ordering and the debounce clock, not OS startup timing.
describe('account file changes', () => {
    it('coalesces login database and WAL changes while ignoring message data and SHM', () => {
        const dbPath = path.join(root, 'login.db');
        const { changed } = subscribe([dbPath, dbPath]);
        expect(files.watch).toHaveBeenCalledExactlyOnceWith(
            root,
            { persistent: false },
            expect.any(Function),
        );
        const watcher = watchers[0]!;
        watcher.emit('change', 'change', 'login.db');
        vi.advanceTimersByTime(100);
        watcher.emit('change', 'change', 'login.db-wal');
        vi.advanceTimersByTime(249);
        expect(changed).not.toHaveBeenCalled();
        watcher.emit('change', 'change', 'nt_msg.db');
        watcher.emit('change', 'change', 'login.db-shm');
        vi.advanceTimersByTime(1);
        expect(changed).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(1000);
        expect(changed).toHaveBeenCalledOnce();
    });

    it('keeps the directory watch across database replacement and WAL recreation', () => {
        const { changed } = subscribe();
        const watcher = watchers[0]!;
        watcher.emit('change', 'rename', 'replacement');
        vi.advanceTimersByTime(250);
        expect(changed).not.toHaveBeenCalled();
        watcher.emit('change', 'rename', 'login.db');
        vi.advanceTimersByTime(250);
        watcher.emit('change', 'change', 'login.db');
        vi.advanceTimersByTime(250);
        watcher.emit('change', 'rename', 'login.db-wal');
        vi.advanceTimersByTime(250);
        watcher.emit('change', 'rename', 'login.db-wal');
        watcher.emit('change', 'rename', 'login.db-wal');
        vi.advanceTimersByTime(250);
        expect(changed).toHaveBeenCalledTimes(4);
        expect(files.watch).toHaveBeenCalledOnce();
        expect(watcher.close).not.toHaveBeenCalled();
    });

    it('moves to newly created directories one level at a time', () => {
        const dbDirectory = path.join(root, 'QQ', 'global', 'nt_db');
        const { changed } = subscribe([path.join(dbDirectory, 'login.db')]);
        const ancestor = watchers[0]!;
        const attempts = files.watch.mock.calls.length;
        ancestor.emit('change', 'rename', 'unrelated');
        ancestor.emit('change', 'change', 'login.db-wal');
        expect(files.watch).toHaveBeenCalledTimes(attempts);
        expect(vi.getTimerCount()).toBe(0);

        let directory = root;

        for (const segment of ['QQ', 'global', 'nt_db']) {
            directory = path.join(directory, segment);
            directories.add(directory);
            const previous = watchers.at(-1)!;
            previous.emit('change', 'rename', segment);
            expect(previous.close).toHaveBeenCalledOnce();
            expect(files.watch).toHaveBeenLastCalledWith(
                directory,
                { persistent: false },
                expect.any(Function),
            );
        }

        vi.advanceTimersByTime(250);
        expect(changed).toHaveBeenCalledOnce();
        watchers.at(-1)!.emit('change', 'change', 'login.db-wal');
        vi.advanceTimersByTime(250);
        expect(changed).toHaveBeenCalledTimes(2);
    });

    it.each(['QQ', null])(
        'observes an entire new directory tree from a %s ancestor event',
        (filename) => {
            const dbDirectory = path.join(root, 'QQ', 'global', 'nt_db');
            const { changed, warning } = subscribe([path.join(dbDirectory, 'login.db')]);
            const ancestor = watchers[0]!;
            directories.add(dbDirectory);
            ancestor.emit('change', 'rename', filename);
            expect(ancestor.close).toHaveBeenCalledOnce();
            expect(files.watch).toHaveBeenLastCalledWith(
                dbDirectory,
                { persistent: false },
                expect.any(Function),
            );
            const attempts = files.watch.mock.calls.length;
            vi.advanceTimersByTime(250);
            expect(changed).toHaveBeenCalledOnce();

            ancestor.emit('change', 'rename', 'QQ');
            ancestor.emit('error', new Error('late error'));
            vi.advanceTimersByTime(250);
            expect(files.watch).toHaveBeenCalledTimes(attempts);
            expect(changed).toHaveBeenCalledOnce();
            expect(warning).not.toHaveBeenCalled();
            watchers.at(-1)!.emit('change', 'change', 'login.db-wal');
            vi.advanceTimersByTime(250);
            expect(changed).toHaveBeenCalledTimes(2);
        },
    );

    it('notifies when the filesystem does not supply a filename', () => {
        const { changed } = subscribe();
        watchers[0]!.emit('change', 'change', null);
        vi.advanceTimersByTime(250);
        expect(changed).toHaveBeenCalledOnce();
    });

    it('closes every watcher and cancels pending notifications on disposal', () => {
        const { changed, stop, warning } = subscribe([
            path.join(root, 'login.db'),
            path.join(root, 'other', 'login.db'),
        ]);
        expect(watchers).toHaveLength(2);
        watchers[0]!.emit('change', 'change', 'login.db');
        vi.advanceTimersByTime(30);
        expect(vi.getTimerCount()).toBe(1);
        stop();
        expect(vi.getTimerCount()).toBe(0);

        for (const watcher of watchers) {
            expect(watcher.close).toHaveBeenCalledOnce();
            watcher.emit('change', 'rename', null);
            watcher.emit('error', new Error('late error'));
        }

        vi.advanceTimersByTime(1000);
        expect(changed).not.toHaveBeenCalled();
        expect(warning).not.toHaveBeenCalled();
    });

    it('reports watch failures without starting a polling fallback', () => {
        files.watch.mockImplementationOnce(() => {
            throw Object.assign(new Error('access denied'), { code: 'EACCES' });
        });
        const { changed, warning } = subscribe();
        expect(warning).toHaveBeenCalledWith(
            'account watch failed: path=%s err=%s',
            path.join(root, 'login.db'),
            'access denied',
        );
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(1000);
        expect(files.watch).toHaveBeenCalledOnce();
        expect(changed).not.toHaveBeenCalled();
    });

    it('reports asynchronous watch errors and closes the failed watcher', () => {
        const { changed, warning } = subscribe();
        const watcher = watchers[0]!;
        watcher.emit('error', new Error('watch unavailable'));
        expect(watcher.close).toHaveBeenCalledOnce();
        expect(warning).toHaveBeenCalledWith(
            'account watch failed: path=%s err=%s',
            path.join(root, 'login.db'),
            'watch unavailable',
        );
        watcher.emit('change', 'change', 'login.db');
        vi.advanceTimersByTime(250);
        expect(changed).not.toHaveBeenCalled();
    });

    it('does not start account file watchers through the production entry point on macOS', () => {
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        const changed = vi.fn();
        subscriptions.push(watchAccountChangesForPids([123], changed));
        expect(files.watch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(changed).not.toHaveBeenCalled();
    });
});
