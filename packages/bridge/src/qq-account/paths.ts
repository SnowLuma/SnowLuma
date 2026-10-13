/**
 * QQ NT's on-disk layout, limited to what locating login.db and an account's
 * databases needs.
 *
 * Windows:
 *   <root>/nt_qq/global/nt_db/login.db
 *   <root>/<uin>/nt_qq/nt_db/nt_msg.db
 *   <root> is the "Tencent Files" directory, which QQ itself records in the
 *   machine-wide UserDataInfo.ini. Account directories are named after the
 *   account's uin.
 *
 * Linux:
 *   <root>/global/nt_db/login.db            (primary)
 *   <root>/nt_qq/global/nt_db/login.db      (supplementary, older layout)
 *   <root>/nt_qq_<hash>/nt_db/nt_msg.db
 *   <root> is ~/.config/QQ and <hash> = md5(md5(uid) + "nt_kernel"), where
 *   `uid` is the account's `u_...` string, not its numeric uin. The directory
 *   name hides the uin, so the accounts come from login.db instead.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Path tail of login.db, which lives outside every account directory. */
const LOGIN_DB_SEGMENTS = ['nt_db', 'login.db'] as const;

/** Candidate QQ data roots, most preferred first. */
export function qqDataRoots(): string[] {
    if (process.platform === 'win32') {
        return windowsDataRoots();
    }

    if (process.platform === 'linux') {
        const configHome = process.env.XDG_CONFIG_HOME;
        const base =
            configHome && configHome.length > 0 ? configHome : path.join(homedir(), '.config');
        return [path.join(base, 'QQ')];
    }

    return [];
}

/**
 * Every candidate login.db under `root`, in merge-priority order.
 *
 * Linux has been seen with a second, Windows-like layout; both are read and
 * merged, letting the primary win.
 */
export function loginDbPaths(root: string): string[] {
    if (process.platform === 'win32') {
        return [path.join(root, 'nt_qq', 'global', ...LOGIN_DB_SEGMENTS)];
    }

    return [
        path.join(root, 'global', ...LOGIN_DB_SEGMENTS),
        path.join(root, 'nt_qq', 'global', ...LOGIN_DB_SEGMENTS),
    ];
}

/** `nt_msg.db` for one account — the file QQ holds while the account is signed in. */
export function ntMsgDbPath(root: string, account: { uin: string; uid: string }): string {
    if (process.platform === 'win32') {
        return path.join(root, account.uin, 'nt_qq', 'nt_db', 'nt_msg.db');
    }

    return path.join(root, accountDirName(account.uid), 'nt_db', 'nt_msg.db');
}

/**
 * The account directory name on Linux: `nt_qq_` followed by
 * `md5(md5(uid) + "nt_kernel")`, lowercase hex.
 */
export function accountDirName(uid: string): string {
    const digest = createHash('md5').update(uid, 'utf8').digest('hex');
    return `nt_qq_${createHash('md5').update(`${digest}nt_kernel`, 'utf8').digest('hex')}`;
}

/**
 * Windows data roots, most preferred first.
 *
 * The authoritative entry is the machine-wide ini QQ writes the chosen data
 * directory into; the remaining entries are the locations QQ uses when that
 * file is missing, including the nested legacy-admin profile layout.
 */
function windowsDataRoots(): string[] {
    const home = homedir();
    const roots: string[] = [];
    const fromIni = tencentFilesRootFromUserDataInfo(home);

    if (fromIni) {
        roots.push(fromIni);
    }

    roots.push(path.join(home, 'Documents', 'Tencent Files'), path.join(home, 'Tencent Files'));

    try {
        for (const entry of readdirSync(home)) {
            if (entry.toLowerCase().startsWith('admin')) {
                roots.push(path.join(home, entry, 'Documents', 'Tencent Files'));
            }
        }
    } catch {
        // An unreadable home directory leaves the static candidates above.
    }

    return [...new Set(roots)];
}

/**
 * `UserDataSavePath` from `<Public>/Documents/Tencent/QQ/UserDataInfo.ini`.
 *
 * The scan is section-aware so `[UserDataImportSet]`'s `OldVerDataPath` is
 * never picked up, and the key is matched with its `=` because the same section
 * also carries `UserDataSavePathType`. The value normally points at the data
 * root already; a value that stops one level short gets the `Tencent Files`
 * segment appended.
 */
export function tencentFilesRootFromUserDataInfo(home = homedir()): string | null {
    const ini = path.join(
        path.dirname(home),
        'Public',
        'Documents',
        'Tencent',
        'QQ',
        'UserDataInfo.ini',
    );
    let text: string;

    try {
        text = readFileSync(ini, 'utf8');
    } catch {
        return null;
    }

    let inDataSet = false;

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();

        if (line.startsWith('[') && line.endsWith(']')) {
            inDataSet = line.toLowerCase() === '[userdataset]';
            continue;
        }

        if (!inDataSet) {
            continue;
        }

        const separator = line.indexOf('=');

        if (
            separator === -1 ||
            line.slice(0, separator).trim().toLowerCase() !== 'userdatasavepath'
        ) {
            continue;
        }

        const value = line.slice(separator + 1).trim();

        if (value.length === 0) {
            return null;
        }

        // The ini always holds Windows paths, so resolve them with the win32
        // flavor wherever this runs.
        return path.win32.basename(value).toLowerCase() === 'tencent files'
            ? value
            : path.win32.join(value, 'Tencent Files');
    }

    return null;
}

/** The first root that exists on disk, or null. */
export function pickQqDataRoot(roots: readonly string[] = qqDataRoots()): string | null {
    return roots.find((root) => existsSync(root)) ?? null;
}
