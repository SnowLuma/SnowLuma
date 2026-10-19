import { errorMessage } from '@snowluma/common/errors';
import { createLogger, type Logger } from '@snowluma/common/logger';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { loginDbPaths, qqDataRootsForPid } from './paths';

export function watchAccountChangesForPids(
    pids: readonly number[],
    onChange: () => void,
    log: Logger = createLogger('QqAccount'),
): () => void {
    const roots = new Set<string>();

    for (const pid of pids) {
        try {
            for (const root of qqDataRootsForPid(pid)) {
                roots.add(root);
            }
        } catch (error) {
            log.warn('account watch root failed: PID=%d err=%s', pid, errorMessage(error));
        }
    }

    return watchAccountFiles([...roots].flatMap(loginDbPaths), onChange, log);
}

/** Watch directories so replacing login.db or recreating its WAL keeps working. */
export function watchAccountFiles(
    dbPaths: readonly string[],
    onChange: () => void,
    log: Logger = createLogger('QqAccount'),
): () => void {
    const watchers = new Map<string, FSWatcher>();
    let timer: NodeJS.Timeout | undefined;

    const changed = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            onChange();
        }, 250);
        timer.unref();
    };

    const observe = (dbPath: string) => {
        watchers.get(dbPath)?.close();
        watchers.delete(dbPath);
        const dbDirectory = path.dirname(dbPath);
        let directory = dbDirectory;

        for (;;) {
            const target = path.relative(directory, dbPath).split(path.sep)[0]!;

            try {
                const watcher = watch(directory, { persistent: false }, (_event, filename) => {
                    if (
                        watchers.get(dbPath) !== watcher ||
                        (filename !== null &&
                            filename !== target &&
                            !(directory === dbDirectory && filename === `${target}-wal`))
                    ) {
                        return;
                    }

                    // QQ may create its data directories after process discovery.
                    if (directory !== dbDirectory) {
                        observe(dbPath);
                    }

                    changed();
                });
                watcher.on('error', (error) => {
                    if (watchers.get(dbPath) !== watcher) {
                        return;
                    }

                    watcher.close();
                    watchers.delete(dbPath);
                    log.warn('account watch failed: path=%s err=%s', dbPath, errorMessage(error));
                });
                watchers.set(dbPath, watcher);
                return;
            } catch (error) {
                const parent = path.dirname(directory);

                if (
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'ENOENT' &&
                    parent !== directory
                ) {
                    directory = parent;
                    continue;
                }

                log.warn('account watch failed: path=%s err=%s', dbPath, errorMessage(error));
                return;
            }
        }
    };

    for (const dbPath of new Set(dbPaths)) {
        observe(dbPath);
    }

    return () => {
        clearTimeout(timer);

        for (const watcher of watchers.values()) {
            watcher.close();
        }

        watchers.clear();
    };
}
