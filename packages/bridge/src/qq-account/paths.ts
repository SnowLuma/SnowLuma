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
 *   <root> is <XDG_CONFIG_HOME|$HOME/.config>/QQ and <hash> =
 *   md5(md5(uid) + "nt_kernel"), where `uid` is the account's `u_...` string,
 *   not its numeric uin. The directory name hides the uin, so the accounts come
 *   from login.db instead.
 *
 *   Every client instance can carry its own HOME (the official Docker framework
 *   runs each extra instance under `/app/qq-acctN`), so the root is resolved per
 *   process rather than once for SnowLuma itself — see `qqDataRootsForPid`.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
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
        return linuxDataRoots(process.env);
    }

    return [];
}

/**
 * Candidate QQ data roots for the HOME `pid` runs under.
 *
 * A client's databases live under the HOME that client was started with, which
 * is not necessarily SnowLuma's own: the official Docker framework gives every
 * extra QQ instance its own HOME. Reading the process environment is the only
 * way to reach those accounts.
 *
 * Falls back to this process's own roots when `pid`'s environment cannot be
 * read (process already gone, or `/proc` hides it), which is the previous
 * behaviour rather than "no roots".
 */
export function qqDataRootsForPid(pid: number): string[] {
    if (process.platform === 'win32') {
        return windowsDataRoots();
    }

    if (process.platform !== 'linux') {
        return [];
    }

    const environment = readProcessEnvironment(pid);
    return environment ? linuxDataRoots(environment) : qqDataRoots();
}

/** Linux roots derived from one environment: `<XDG_CONFIG_HOME|~/.config>/QQ`. */
function linuxDataRoots(environment: { HOME?: string; XDG_CONFIG_HOME?: string }): string[] {
    const configHome = environment.XDG_CONFIG_HOME;
    const home = environment.HOME;
    const base =
        configHome && configHome.length > 0
            ? configHome
            : home && home.length > 0
              ? path.join(home, '.config')
              : path.join(homedir(), '.config');
    return [path.join(base, 'QQ')];
}

/**
 * The NUL-separated environment of `pid` from `/proc`, or null when it cannot
 * be read. Only the variables the data root depends on are kept.
 */
function readProcessEnvironment(pid: number): { HOME?: string; XDG_CONFIG_HOME?: string } | null {
    let raw: string;

    try {
        raw = readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
        return null;
    }

    const environment: { HOME?: string; XDG_CONFIG_HOME?: string } = {};

    for (const entry of raw.split('\0')) {
        const separator = entry.indexOf('=');

        if (separator <= 0) {
            continue;
        }

        const name = entry.slice(0, separator);

        if (name === 'HOME' || name === 'XDG_CONFIG_HOME') {
            environment[name] = entry.slice(separator + 1);
        }
    }

    return environment;
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
