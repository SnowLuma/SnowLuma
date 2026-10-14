/**
 * Which local QQ account each client process is signed in as.
 *
 * login.db supplies the accounts that exist on this machine; the process
 * holding an account's `nt_msg.db` identifies where that account is signed in.
 * Both halves are read-only, so the detection can run alongside a client the
 * operator is actively using.
 */

import { isQqProcessName, probeDbLock } from './db-lock';
import { readLocalAccounts } from './login-db';
import { ntMsgDbPath, pickQqDataRoot, qqDataRoots } from './paths';

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
 * `roots` exists so callers can name the QQ data directories instead of relying
 * on the well-known locations.
 *
 * Empty means "nothing to report" — a machine without QQ data, or a login.db
 * that cannot be read.
 */
export async function detectAccountLogins(
    roots: readonly string[] = qqDataRoots(),
): Promise<AccountLoginState[]> {
    const root = pickQqDataRoot(roots);

    if (!root) {
        return [];
    }

    const accounts = await readLocalAccounts(root);
    return accounts.map((account) => ({
        ...account,
        pid: findHostingPid(ntMsgDbPath(root, account)),
    }));
}

/**
 * Uin currently signed in on `pid`, or null.
 *
 * Used to hand the injected hook the identity of an account the client restored
 * on its own, where no login event ever crosses the pipe.
 */
export async function detectUinForPid(pid: number): Promise<string | null> {
    const accounts = await detectAccountLogins();
    return accounts.find((account) => account.pid === pid)?.uin ?? null;
}

/** The QQ pid holding `dbPath`, ignoring holders that are not the client itself. */
export function findHostingPid(dbPath: string): number | null {
    const holder = probeDbLock(dbPath).find((candidate) => isQqProcessName(candidate.name));
    return holder ? holder.pid : null;
}
