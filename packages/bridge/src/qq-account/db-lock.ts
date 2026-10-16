/**
 * Which process holds a QQ database file?
 *
 * A signed-in account keeps its `nt_msg.db` held by the QQ client process for as
 * long as the session lives, so reverse-mapping that one file answers both "is
 * this account signed in?" and "which pid is hosting it?". The probe is
 * strictly read-only: it never opens the database for writing and never takes a
 * lock of its own.
 */

import fs from 'node:fs';
import { getNativeHookAddon } from '../injector';

/** One process holding the database open or locking it. */
export interface DbLockHolder {
    pid: number;
    /** Process name as the platform reports it; empty when unavailable. */
    name: string;
}

/**
 * Every process holding `dbPath`, most specific first.
 *
 * A missing or unreadable file yields no holders rather than an error: callers
 * only distinguish "held by QQ" from "not held by QQ".
 */
export function probeDbLock(dbPath: string): DbLockHolder[] {
    if (process.platform === 'win32') {
        return probeWindowsHolders(dbPath);
    }

    return process.platform === 'linux' ? probeLinuxLocks(dbPath) : [];
}

/**
 * Windows attributes holders through the Restart Manager, which reports every
 * process holding the file open together with a name for each. QQ keeps an
 * account's `nt_msg.db` open while signed in, so a QQ entry in that list both
 * proves the login and yields the hosting pid.
 *
 * When the query cannot run, the result is empty rather than an error, so a
 * caller never mistakes an unavailable probe for a signed-out account.
 */
function probeWindowsHolders(dbPath: string): DbLockHolder[] {
    const held = getNativeHookAddon()?.probeDbLock?.(dbPath);

    if (!Array.isArray(held)) {
        return [];
    }

    const holders: DbLockHolder[] = [];
    const seen = new Set<number>();

    for (const entry of held) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }

        const pid = (entry as { pid?: unknown }).pid;
        const name = (entry as { name?: unknown }).name;

        if (!Number.isInteger(pid) || (pid as number) <= 0 || seen.has(pid as number)) {
            continue;
        }

        seen.add(pid as number);
        holders.push({ pid: pid as number, name: typeof name === 'string' ? name : '' });
    }

    return holders;
}

/** Whether a platform-reported process name belongs to the QQ client. */
export function isQqProcessName(name: string): boolean {
    return (
        name
            .trim()
            .toLowerCase()
            .replace(/\.exe$/, '') === 'qq'
    );
}

/**
 * POSIX advisory locks on `dbPath`, read from `/proc/locks`.
 *
 * SQLite registers a lock on the database while a connection is in a
 * transaction, and the table entry carries the holder's pid. Lock entries only
 * name the process, never the path, so the file's device and inode are matched
 * against the entry's `major:minor:inode` key.
 */
function probeLinuxLocks(dbPath: string): DbLockHolder[] {
    const stat = fs.statSync(dbPath, { throwIfNoEntry: false });

    if (!stat) {
        return [];
    }

    const key = deviceInodeKey(stat.dev, stat.ino);
    let table: string;

    try {
        table = fs.readFileSync('/proc/locks', 'utf8');
    } catch {
        return [];
    }

    const holders: DbLockHolder[] = [];
    const seen = new Set<number>();

    for (const line of table.split('\n')) {
        // `<id>: <type> <advisory|mandatory> <read|write> <pid> <dev>:<inode> <start> <end>`
        const fields = line.trim().split(/\s+/);

        if (fields.length < 8 || fields[5] !== key) {
            continue;
        }

        const pid = Number(fields[4]);

        if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) {
            continue;
        }

        seen.add(pid);
        holders.push({ pid, name: readProcessName(pid) });
    }

    return holders;
}

/** `/proc/locks` prints the device as `major:minor` in hex, zero-padded. */
function deviceInodeKey(device: number, inode: number): string {
    const major = (device >> 8) & 0xfff;
    const minor = (device & 0xff) | ((device >> 12) & 0xfff00);
    return `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${inode}`;
}

/** `/proc/<pid>/comm`, empty when the process is gone or unreadable. */
function readProcessName(pid: number): string {
    try {
        return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    } catch {
        return '';
    }
}
