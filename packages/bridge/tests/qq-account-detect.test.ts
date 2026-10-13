import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
    readLocalAccounts: vi.fn(),
    probeDbLock: vi.fn(),
}));

// The account list and the holder probe are covered on their own; this file is
// about how the two are joined.
vi.mock('../src/qq-account/login-db', () => ({ readLocalAccounts: mocks.readLocalAccounts }));
vi.mock('../src/qq-account/db-lock', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/qq-account/db-lock')>()),
    probeDbLock: mocks.probeDbLock,
}));

import { detectAccountLogins } from '../src/qq-account/detect';
import { ntMsgDbPath } from '../src/qq-account/paths';

const ALICE = { uin: '10001', uid: 'u_alice', nickname: 'Alice' };
const BOB = { uin: '10002', uid: 'u_bob', nickname: 'Bob' };

const roots: string[] = [];

afterEach(async () => {
    mocks.readLocalAccounts.mockReset();
    mocks.probeDbLock.mockReset();

    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

async function makeRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'snowluma-detect-'));
    roots.push(root);
    return root;
}

describe('local account detection', () => {
    it('labels each account with the process holding its database', async () => {
        const root = await makeRoot();
        mocks.readLocalAccounts.mockResolvedValue([ALICE, BOB]);
        mocks.probeDbLock.mockImplementation((dbPath: string) => {
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

    it('reads the first data root that exists', async () => {
        const root = await makeRoot();
        mocks.readLocalAccounts.mockResolvedValue([]);

        await detectAccountLogins([path.join(root, 'absent'), root]);

        expect(mocks.readLocalAccounts).toHaveBeenCalledWith(root);
    });

    it('reports nothing when no data root exists', async () => {
        const root = await makeRoot();

        await expect(detectAccountLogins([path.join(root, 'absent')])).resolves.toEqual([]);
        expect(mocks.readLocalAccounts).not.toHaveBeenCalled();
    });
});
