import fs from 'node:fs/promises';
import { getNativeHookAddon } from '../injector';

export interface DatabaseHolder {
    pid: number;
    name: string;
}

export async function getDatabaseHolders(dbPath: string): Promise<DatabaseHolder[]> {
    if (process.platform === 'win32') {
        return getWindowsHolders(dbPath);
    }

    return process.platform === 'linux' ? getLinuxHolders(dbPath) : [];
}

async function getWindowsHolders(dbPath: string): Promise<DatabaseHolder[]> {
    const addon = getNativeHookAddon();

    if (!addon?.getFileHoldersAsync) {
        throw new Error('Windows account detection requires a hook addon with getFileHoldersAsync');
    }

    const holders = await addon.getFileHoldersAsync(dbPath);

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
async function getLinuxHolders(dbPath: string): Promise<DatabaseHolder[]> {
    const stat = await fs.stat(dbPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
            return null;
        }

        throw error;
    });

    if (!stat) {
        return [];
    }

    const key = deviceInodeKey(stat.dev, stat.ino);
    const table = await fs.readFile('/proc/locks', 'utf8');
    const holders: DatabaseHolder[] = [];
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
        holders.push({ pid, name: await readProcessName(pid) });
    }

    return holders;
}

function deviceInodeKey(device: number, inode: number): string {
    const major = (device >> 8) & 0xfff;
    const minor = (device & 0xff) | ((device >> 12) & 0xfff00);
    return `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${inode}`;
}

async function readProcessName(pid: number): Promise<string> {
    try {
        return (await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return '';
        }

        throw error;
    }
}
