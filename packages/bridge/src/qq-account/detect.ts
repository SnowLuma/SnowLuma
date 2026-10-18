import { createLogger } from '@snowluma/common/logger';
import { isQqProcessName, getDatabaseHolders } from './database-holders';
import { readLocalAccounts, type LocalAccount } from './login-db';
import { loginDbPaths, ntMsgDbPath, qqDataRoots, qqDataRootsForPid } from './paths';

const log = createLogger('QqAccount');
const reportedFailures = new Map<string, string>();

export interface AccountLoginState extends LocalAccount {
    pid: number | null;
}

export async function detectAccountLogins(
    roots: readonly string[] = qqDataRoots(),
): Promise<AccountLoginState[]> {
    const states: AccountLoginState[] = [];

    for (const root of roots) {
        const report = await readLocalAccounts(root);

        for (const dbPath of loginDbPaths(root)) {
            const failure = report.failures.find((item) => item.path === dbPath);

            if (!failure) {
                reportedFailures.delete(dbPath);
                continue;
            }

            const detail =
                failure.error instanceof Error
                    ? failure.error.message
                    : String(failure.error ?? '');
            const reason = detail ? failure.reason + ': ' + detail : failure.reason;

            if (reportedFailures.get(dbPath) !== reason) {
                reportedFailures.set(dbPath, reason);
                log.warn('login.db unreadable: path=%s reason=%s', dbPath, reason);
            }
        }

        for (const account of report.accounts) {
            const holder = (await getDatabaseHolders(ntMsgDbPath(root, account))).find(
                (candidate) => isQqProcessName(candidate.name),
            );
            states.push({ ...account, pid: holder?.pid ?? null });
        }
    }

    return states;
}

export async function detectAccountLoginsForPids(
    pids: readonly number[],
): Promise<AccountLoginState[]> {
    const roots = [...new Set(pids.flatMap((pid) => qqDataRootsForPid(pid)))];
    return detectAccountLogins(roots);
}

export async function detectUinForPid(pid: number): Promise<string | null> {
    const accounts = await detectAccountLoginsForPids([pid]);
    return accounts.find((account) => account.pid === pid)?.uin ?? null;
}
