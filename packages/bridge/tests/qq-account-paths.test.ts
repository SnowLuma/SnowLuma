import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    accountDirName,
    loginDbPaths,
    ntMsgDbPath,
    tencentFilesRootFromUserDataInfo,
} from '../src/qq-account/paths';

const IS_WINDOWS = process.platform === 'win32';

describe('QQ data paths', () => {
    it('derives the Linux account directory from the account uid', () => {
        // md5(md5("u_test_account") + "nt_kernel")
        expect(accountDirName('u_test_account')).toBe('nt_qq_7b9b3c3f2cf89e087b2e024777ea5f5f');
    });

    it('lists the login.db locations of the current platform', () => {
        const root = 'root';
        const windows = path.join(root, 'nt_qq', 'global', 'nt_db', 'login.db');

        expect(loginDbPaths(root)).toEqual(
            IS_WINDOWS ? [windows] : [path.join(root, 'global', 'nt_db', 'login.db'), windows],
        );
    });

    it('locates an account database per platform', () => {
        const root = 'root';
        const account = { uin: '10001', uid: 'u_test_account' };

        expect(ntMsgDbPath(root, account)).toBe(
            IS_WINDOWS
                ? path.join(root, '10001', 'nt_qq', 'nt_db', 'nt_msg.db')
                : path.join(root, 'nt_qq_7b9b3c3f2cf89e087b2e024777ea5f5f', 'nt_db', 'nt_msg.db'),
        );
    });
});

describe('Windows data root detection', () => {
    /** Recreate `<Public>/Documents/Tencent/QQ/UserDataInfo.ini` for a fake home. */
    async function withUserDataInfo(
        contents: string,
        run: (home: string) => Promise<void> | void,
    ): Promise<void> {
        const base = await mkdtemp(path.join(os.tmpdir(), 'snowluma-ini-'));

        try {
            const home = path.join(base, 'user');
            const ini = path.join(base, 'Public', 'Documents', 'Tencent', 'QQ', 'UserDataInfo.ini');
            await mkdir(path.dirname(ini), { recursive: true });
            await writeFile(ini, contents, 'utf8');
            await run(home);
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    }

    it('reads UserDataSavePath from the ini QQ itself writes', async () => {
        await withUserDataInfo(
            '[UserDataSet]\nUserDataSavePath=D:\\Tencent\\Tencent Files\n',
            (home) => {
                expect(tencentFilesRootFromUserDataInfo(home)).toBe('D:\\Tencent\\Tencent Files');
            },
        );
    });

    it('appends the Tencent Files segment when the ini stops one level short', async () => {
        await withUserDataInfo('[UserDataSet]\nUserDataSavePath=D:\\Tencent\n', (home) => {
            expect(tencentFilesRootFromUserDataInfo(home)).toBe('D:\\Tencent\\Tencent Files');
        });
    });

    it('ignores other sections and the UserDataSavePathType key', async () => {
        await withUserDataInfo(
            [
                '[UserDataImportSet]',
                'OldVerDataPath=D:\\Legacy\\Tencent Files',
                '[UserDataSet]',
                'UserDataSavePathType=2',
                'UserDataSavePath=E:\\Current\\Tencent Files',
                '',
            ].join('\n'),
            (home) => {
                expect(tencentFilesRootFromUserDataInfo(home)).toBe('E:\\Current\\Tencent Files');
            },
        );
    });

    it('reports nothing when the ini is missing', async () => {
        const base = await mkdtemp(path.join(os.tmpdir(), 'snowluma-ini-'));

        try {
            expect(tencentFilesRootFromUserDataInfo(path.join(base, 'absent'))).toBeNull();
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    it('reports nothing when the ini has no usable path', async () => {
        await withUserDataInfo('[UserDataSet]\nUserDataSavePath=\n', (home) => {
            expect(tencentFilesRootFromUserDataInfo(home)).toBeNull();
        });
    });
});
