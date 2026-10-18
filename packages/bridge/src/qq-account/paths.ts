import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const LOGIN_DB_SEGMENTS = ['nt_db', 'login.db'] as const;

export function qqDataRoots(): string[] {
    if (process.platform === 'win32') {
        return windowsDataRoots();
    }

    if (process.platform === 'linux') {
        return linuxDataRoots({ ...process.env, HOME: process.env.HOME || homedir() });
    }

    return [];
}

/** Each Linux client owns its HOME; an unavailable process has no known root. */
export function qqDataRootsForPid(pid: number): string[] {
    if (process.platform === 'win32') {
        return windowsDataRoots();
    }

    if (process.platform !== 'linux') {
        return [];
    }

    const environment = readProcessEnvironment(pid);
    return environment ? linuxDataRoots(environment) : [];
}

function linuxDataRoots(environment: { HOME?: string; XDG_CONFIG_HOME?: string }): string[] {
    const base =
        environment.XDG_CONFIG_HOME ||
        (environment.HOME ? path.join(environment.HOME, '.config') : null);
    return base ? [path.join(base, 'QQ')] : [];
}

function readProcessEnvironment(pid: number): { HOME?: string; XDG_CONFIG_HOME?: string } | null {
    let raw: string;

    try {
        raw = readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return null;
        }

        throw error;
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

/** Both Linux layouts occur in QQ installations; the primary takes precedence. */
export function loginDbPaths(root: string): string[] {
    if (process.platform === 'win32') {
        return [path.join(root, 'nt_qq', 'global', ...LOGIN_DB_SEGMENTS)];
    }

    return [
        path.join(root, 'global', ...LOGIN_DB_SEGMENTS),
        path.join(root, 'nt_qq', 'global', ...LOGIN_DB_SEGMENTS),
    ];
}

export function ntMsgDbPath(root: string, account: { uin: string; uid: string }): string {
    if (process.platform === 'win32') {
        return path.join(root, account.uin, 'nt_qq', 'nt_db', 'nt_msg.db');
    }

    return path.join(root, accountDirName(account.uid), 'nt_db', 'nt_msg.db');
}

export function accountDirName(uid: string): string {
    const digest = createHash('md5').update(uid, 'utf8').digest('hex');
    return `nt_qq_${createHash('md5').update(`${digest}nt_kernel`, 'utf8').digest('hex')}`;
}

function windowsDataRoots(): string[] {
    const configured = tencentFilesRootFromUserDataInfo();
    return [configured ?? path.join(homedir(), 'Documents', 'Tencent Files')];
}

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
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return null;
        }

        throw error;
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
