/**
 * Which local QQ account each client process is signed in as.
 *
 * login.db supplies the accounts that exist on this machine; the process
 * holding an account's `nt_msg.db` identifies where that account is signed in.
 * Both halves are read-only, so the detection can run alongside a client the
 * operator is actively using.
 */

import { createLogger } from '@snowluma/common/logger';
import { isQqProcessName, probeDbLock } from './db-lock';
import { readLocalAccounts, type LocalAccount } from './login-db';
import { ntMsgDbPath, qqDataRoots, qqDataRootsForPid } from './paths';

const log = createLogger('QqAccount');

/**
 * Failure keys already logged, so a login.db that stays unreadable is reported
 * once instead of on every re-probe. Cleared per key as soon as that path reads
 * cleanly again, so a recurrence is reported too.
 */
const reportedFailures = new Set<string>();

/** One locally known account, together with the process hosting it. */
export interface AccountLoginState {
    uin: string;
    uid: string;
    nickname: string;
    /** QQ process holding this account's database, or null when not signed in. */
    pid: number | null;
}

/**
 * Every account QQ has cached locally, with the pid it is signed in on.
 *
 * Accounts from every root are merged by uin, so a machine that runs several
 * clients under separate HOMEs reports all of them rather than whichever root
 * happened to be checked first.
 *
 * Empty means "nothing to report" — a machine without QQ data. A login.db that
 * is present but unreadable is logged rather than silently folded into that
 * same empty list, because the two mean very different things to an operator.
 */
export async function detectAccountLogins(
    roots: readonly string[] = qqDataRoots(),
): Promise<AccountLoginState[]> {
    const merged = new Map<string, LocalAccount>();
    const failedThisRound = new Set<string>();

    for (const root of roots) {
        const report = await readLocalAccounts(root);

        for (const failure of report.failures) {
            const key = `${failure.path}\u0000${failure.reason}`;
            failedThisRound.add(key);

            if (reportedFailures.has(key)) {
                continue;
            }

            reportedFailures.add(key);
            log.warn(
                'login.db unreadable: path=%s reason=%s; accounts under it cannot be reported',
                failure.path,
                failure.reason,
            );
        }

        for (const account of report.accounts) {
            if (!merged.has(account.uin)) {
                merged.set(account.uin, account);
            }
        }
    }

    // A path that reads cleanly again may fail once more later; forget it so the
    // next occurrence is reported instead of being swallowed as "already seen".
    for (const key of reportedFailures) {
        if (!failedThisRound.has(key)) {
            reportedFailures.delete(key);
        }
    }

    const states: AccountLoginState[] = [];

    for (const account of merged.values()) {
        // The account directory name is derived from the account, not the root,
        // so the hosting pid is the one process that holds this account's
        // database wherever its root is — searching every root is both correct
        // and what finds an account signed in under another instance's HOME.
        states.push({ ...account, pid: findHostingPid(roots, account) });
    }

    return states;
}

/**
 * Accounts of the given QQ processes, each resolved against the HOME that
 * process actually runs under.
 *
 * A client's databases live under its own HOME, which is not necessarily
 * SnowLuma's: the official Docker framework starts every extra instance with
 * its own (`/app/qq-acctN`). Resolving per pid is what lets those instances be
 * labelled; a single root taken from SnowLuma's environment sees only its own.
 */
export async function detectAccountLoginsForPids(
    pids: readonly number[],
): Promise<AccountLoginState[]> {
    const roots: string[] = [];

    for (const pid of pids) {
        for (const root of qqDataRootsForPid(pid)) {
            if (!roots.includes(root)) {
                roots.push(root);
            }
        }
    }

    return detectAccountLogins(roots);
}

/**
 * Uin currently signed in on `pid`, or null.
 *
 * Used to hand the injected hook the identity of an account the client restored
 * on its own, where no login event ever crosses the pipe.
 */
export async function detectUinForPid(pid: number): Promise<string | null> {
    const accounts = await detectAccountLogins(qqDataRootsForPid(pid));
    return accounts.find((account) => account.pid === pid)?.uin ?? null;
}

/**
 * The QQ pid holding `account`'s database under any of `roots`, ignoring
 * holders that are not the client itself.
 *
 * More than one root is searched because the account directory lives under the
 * HOME of the client that signed it in, which the account record does not name.
 */
export function findHostingPid(roots: readonly string[], account: LocalAccount): number | null {
    for (const root of roots) {
        const holder = probeDbLock(ntMsgDbPath(root, account)).find((candidate) =>
            isQqProcessName(candidate.name),
        );

        if (holder) {
            return holder.pid;
        }
    }

    return null;
}
