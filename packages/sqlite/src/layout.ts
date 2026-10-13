// Upgrade these together with package.json, then rerun the native and bundle tests.
export const DRIVER_VERSION = '9.1.0';
export const NATIVE_INTERFACE_VERSION = 1;
export const REQUIRED_NAPI_VERSION = 10;
export const RELEASE_PREBUILDS = './native/sqlite/prebuilds/';

export function prebuildFiles(target: string): string[] {
    if (!/^(win32|linux|darwin)-(x64|arm64)$/.test(target)) {
        throw new Error(`Unsupported SQLite target: ${target}`);
    }

    return (
        target.startsWith('linux-')
            ? ['@appthreat+sqlite3.glibc.node', '@appthreat+sqlite3.musl.node']
            : ['@appthreat+sqlite3.node']
    ).map((file) => `${target}/${file}`);
}

export function runtimePrebuild(platform: string, arch: string, libc?: 'glibc' | 'musl'): string {
    const target = `${platform}-${arch}`;
    const files = prebuildFiles(target);

    if (platform !== 'linux') {
        return files[0];
    }

    if (!libc) {
        throw new Error('SQLite requires an explicit Linux libc selection');
    }

    return `${target}/@appthreat+sqlite3.${libc}.node`;
}

export function assertRuntime(node: string, napi: string | undefined): void {
    if (!(Number.parseInt(node, 10) >= 24) || !(Number(napi) >= REQUIRED_NAPI_VERSION)) {
        throw new Error(
            `SQLite requires Node >=24 and Node-API >=${REQUIRED_NAPI_VERSION}; got Node ${node}, Node-API ${napi ?? 'unavailable'}`,
        );
    }
}

export function runtimeLibc(report: object): 'glibc' | 'musl' {
    if (!('header' in report) || !report.header || typeof report.header !== 'object') {
        throw new Error('Cannot determine SQLite libc: Node diagnostic report has no header');
    }

    return 'glibcVersionRuntime' in report.header &&
        typeof report.header.glibcVersionRuntime === 'string' &&
        report.header.glibcVersionRuntime.length > 0
        ? 'glibc'
        : 'musl';
}
