import fs from 'node:fs';
import { getNativeHookAddon } from '../injector';

export interface DbLockHolder {
    pid: number;

    name: string;
}

export function probeDbLock(dbPath: string): DbLockHolder[] {
    if (process.platform === 'win32') {
        return probeWindowsHolders(dbPath);
    }

    return process.platform === 'linux' ? probeLinuxLocks(dbPath) : [];
}

function probeWindowsHolders(dbPath: string): DbLockHolder[] {
    const addon = getNativeHookAddon();

    if (!addon?.probeDbLock) {
        throw new Error('Windows account detection requires a hook addon with probeDbLock');
    }

    const holders = addon.probeDbLock(dbPath);

    if (
        !Array.isArray(holders) ||
        holders.some(
            (holder) =>
                !holder ||
                !Number.isInteger(holder.pid) ||
                holder.pid <= 0 ||
                typeof holder.name !== 'string',
        )
    ) {
        throw new Error('Invalid database holders returned by the hook addon');
    }

    return holders;
}

export function isQqProcessName(name: string): boolean {
    return (
        name
            .trim()
            .toLowerCase()
            .replace(/\.exe$/, '') === 'qq'
    );
}

/** Match POSIX locks by device and inode; the table does not contain file paths. */
function probeLinuxLocks(dbPath: string): DbLockHolder[] {
    const stat = fs.statSync(dbPath, { throwIfNoEntry: false });

    if (!stat) {
        return [];
    }

    const key = deviceInodeKey(stat.dev, stat.ino);
    const table = fs.readFileSync('/proc/locks', 'utf8');
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

function deviceInodeKey(device: number, inode: number): string {
    const major = (device >> 8) & 0xfff;
    const minor = (device & 0xff) | ((device >> 12) & 0xfff00);
    return `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${inode}`;
}

function readProcessName(pid: number): string {
    try {
        return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    } catch {
        return '';
    }
}
