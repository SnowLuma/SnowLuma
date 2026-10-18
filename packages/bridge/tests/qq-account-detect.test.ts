import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';

const mocks = vi.hoisted(() => ({
    readLocalAccounts: vi.fn(),
    getDatabaseHolders: vi.fn(),
}));

// The account list and the holder probe are covered on their own; this file is
// about how the two are joined.
vi.mock('../src/qq-account/login-db', () => ({ readLocalAccounts: mocks.readLocalAccounts }));
vi.mock('../src/qq-account/database-holders', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/qq-account/database-holders')>()),
    getDatabaseHolders: mocks.getDatabaseHolders,
}));

import { detectAccountLogins, detectAccountLoginsForPids } from '../src/qq-account/detect';
import { loginDbPaths, ntMsgDbPath } from '../src/qq-account/paths';

const ALICE = { uin: '10001', uid: 'u_alice', nickname: 'Alice' };
const BOB = { uin: '10002', uid: 'u_bob', nickname: 'Bob' };

const roots: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

afterEach(async () => {
    mocks.readLocalAccounts.mockReset();
    mocks.getDatabaseHolders.mockReset();

    for (const child of children.splice(0)) {
        child.kill();
    }

    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

async function makeRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'snowluma-detect-'));
    roots.push(root);
    return root;
}

/**
 * A live process whose `/proc/<pid>/environ` carries `HOME` (and any extra
 * variables given).
 *
 * `XDG_CONFIG_HOME` is dropped unless the caller sets it: it outranks `HOME`
 * when deriving the data root, and a CI runner exports its own, which would
 * otherwise decide the result instead of the HOME under test.
 *
 * Resolves only once the child has run past `execve`, because `/proc/<pid>`
 * still shows the parent's environment before that.
 */
function spawnWithHome(home: string, extra: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.XDG_CONFIG_HOME;
        Object.assign(env, { HOME: home }, extra);
        const child = spawn(
            process.execPath,
            ['-e', 'console.log("ready"); setTimeout(() => {}, 30000)'],
            { env, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        children.push(child);
        child.stdout!.once('data', () => resolve(child.pid!));
        child.once('error', reject);
    });
}

describe('local account detection', () => {
    it('labels each account with the process holding its database', async () => {
        const root = await makeRoot();
        mocks.readLocalAccounts.mockResolvedValue({ accounts: [ALICE, BOB], failures: [] });
        mocks.getDatabaseHolders.mockImplementation(async (dbPath: string) => {
            if (dbPath === ntMsgDbPath(root, ALICE)) {
                return [{ pid: 4242, name: 'qq' }];
            }

            // A holder that is not the client must not be mistaken for one.
            return [{ pid: 999, name: 'node' }];
        });

        await expect(detectAccountLogins([root])).resolves.toEqual([
            { ...ALICE, pid: 4242 },
            { ...BOB, pid: null },
        ]);
    });

    it('merges the accounts of every root instead of stopping at the first', async () => {
        const own = await makeRoot();
        const extra = await makeRoot();
        mocks.readLocalAccounts.mockImplementation(async (root: string) =>
            root === own ? { accounts: [ALICE], failures: [] } : { accounts: [BOB], failures: [] },
        );
        mocks.getDatabaseHolders.mockImplementation(async (dbPath: string) =>
            dbPath === ntMsgDbPath(extra, BOB) ? [{ pid: 5151, name: 'qq' }] : [],
        );

        await expect(detectAccountLogins([own, extra])).resolves.toEqual([
            { ...ALICE, pid: null },
            { ...BOB, pid: 5151 },
        ]);

        // An account held under an instance's own HOME is still labelled, which
        // is what a single-root lookup cannot do.
        expect(mocks.getDatabaseHolders).toHaveBeenCalledWith(ntMsgDbPath(extra, BOB));
    });

    it('keeps account records with the same uin scoped to their own root', async () => {
        const first = await makeRoot();
        const second = await makeRoot();
        mocks.readLocalAccounts.mockImplementation(async (root: string) =>
            root === first
                ? { accounts: [ALICE], failures: [] }
                : { accounts: [{ ...ALICE, nickname: 'Stale' }], failures: [] },
        );
        mocks.getDatabaseHolders.mockImplementation(async (file: string) =>
            file === ntMsgDbPath(second, ALICE) ? [{ pid: 5151, name: 'qq' }] : [],
        );

        await expect(detectAccountLogins([first, second])).resolves.toEqual([
            { ...ALICE, pid: null },
            { ...ALICE, nickname: 'Stale', pid: 5151 },
        ]);
    });

    it('reports nothing when there are no roots', async () => {
        await expect(detectAccountLogins([])).resolves.toEqual([]);
        expect(mocks.readLocalAccounts).not.toHaveBeenCalled();
    });

    it('logs a named reason when a login.db is present but unreadable', async () => {
        const root = await makeRoot();
        const entries: LogEntry[] = [];
        const previousLevel = getLogLevel();
        setLogLevel('debug');
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));

        try {
            mocks.readLocalAccounts.mockResolvedValue({
                accounts: [],
                failures: [
                    {
                        path: loginDbPaths(root)[0]!,
                        reason: 'undecryptable',
                    },
                ],
            });
            mocks.getDatabaseHolders.mockResolvedValue([]);

            // An unreadable login.db must not look like "no accounts": an
            // operator reading the log has to see why nothing was reported.
            await detectAccountLogins([root]);
        } finally {
            unsubscribe();
            setLogLevel(previousLevel);
        }

        const warned = entries.filter(
            (entry) => entry.level === 'warn' && entry.scope === 'QqAccount',
        );
        expect(warned).toHaveLength(1);
        expect(warned[0]!.message).toContain('login.db unreadable');
        expect(warned[0]!.message).toContain('undecryptable');
    });
});

describe.runIf(process.platform === 'linux')('per-process data roots', () => {
    it('reads each pid against the HOME that process runs under', async () => {
        const home = await makeRoot();
        const pid = await spawnWithHome(home);
        mocks.readLocalAccounts.mockResolvedValue({ accounts: [], failures: [] });
        mocks.getDatabaseHolders.mockResolvedValue([]);

        await detectAccountLoginsForPids([pid]);

        // `<HOME>/.config/QQ`, from the child's environment rather than ours.
        expect(mocks.readLocalAccounts).toHaveBeenCalledWith(path.join(home, '.config', 'QQ'));
    });

    it('asks each root once when several processes share a HOME', async () => {
        const home = await makeRoot();
        const pids = [await spawnWithHome(home), await spawnWithHome(home)];
        mocks.readLocalAccounts.mockResolvedValue({ accounts: [], failures: [] });
        mocks.getDatabaseHolders.mockResolvedValue([]);

        await detectAccountLoginsForPids(pids);

        expect(mocks.readLocalAccounts).toHaveBeenCalledTimes(1);
    });

    it('honours XDG_CONFIG_HOME of the process over its HOME', async () => {
        const home = await makeRoot();
        const configHome = await makeRoot();
        const pid = await spawnWithHome(home, { XDG_CONFIG_HOME: configHome });
        mocks.readLocalAccounts.mockResolvedValue({ accounts: [], failures: [] });
        mocks.getDatabaseHolders.mockResolvedValue([]);

        await detectAccountLoginsForPids([pid]);

        // The XDG variable outranks HOME, as it does for the client itself.
        expect(mocks.readLocalAccounts).toHaveBeenCalledWith(path.join(configHome, 'QQ'));
    });

    it('keeps each process on its own root when the HOMEs differ', async () => {
        const first = await makeRoot();
        const second = await makeRoot();
        const pids = [await spawnWithHome(first), await spawnWithHome(second)];
        mocks.readLocalAccounts.mockResolvedValue({ accounts: [], failures: [] });
        mocks.getDatabaseHolders.mockResolvedValue([]);

        await detectAccountLoginsForPids(pids);

        expect(mocks.readLocalAccounts).toHaveBeenCalledWith(path.join(first, '.config', 'QQ'));
        expect(mocks.readLocalAccounts).toHaveBeenCalledWith(path.join(second, '.config', 'QQ'));
    });

    it('does not substitute another HOME when the pid is gone', async () => {
        const home = await makeRoot();
        const pid = await spawnWithHome(home);
        mocks.readLocalAccounts.mockResolvedValue({ accounts: [], failures: [] });
        mocks.getDatabaseHolders.mockResolvedValue([]);

        // The child exits, so its environment is no longer readable.
        await new Promise<void>((resolve) => {
            const child = children[children.length - 1]!;
            child.once('exit', () => resolve());
            child.kill();
        });

        await detectAccountLoginsForPids([pid]);

        expect(mocks.readLocalAccounts).not.toHaveBeenCalled();
    });
});
