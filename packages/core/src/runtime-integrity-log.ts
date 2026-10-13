import { hasLowProcessIntegrity, type RuntimeIntegrity } from '@snowluma/bridge';
import { createLogger } from '@snowluma/common/logger';

const log = createLogger('App');
const LEVEL_NAMES: Record<number, string> = {
    0: 'Untrusted',
    4096: 'Low',
    8192: 'Medium',
    8448: 'Medium Plus',
    12288: 'High',
    16384: 'System',
    20480: 'Protected Process',
};

function level(rid: number): string {
    return `${LEVEL_NAMES[rid] ?? 'Unknown'} (RID=${rid})`;
}

/** Called once by main(), never by WebUI polling or warning dismissal. */
export function logRuntimeIntegrity(integrity: RuntimeIntegrity): void {
    if (integrity.status === 'unsupported') {
        return;
    }

    if (integrity.status === 'unavailable') {
        log.warn('Node integrity: unknown (%s)', integrity.error);
        return;
    }

    const token = integrity.process;
    const file = integrity.file;
    const tokenText =
        token.status === 'ok'
            ? level(token.rid)
            : `unknown (${token.operation}, Win32=${token.code})`;
    const fileText =
        file.status === 'error'
            ? `unknown (${file.operation}, Win32=${file.code})`
            : file.label
              ? `${level(file.label.rid)}, inherited=${file.label.inherited}, policy=${file.label.policy}`
              : 'unlabeled';
    // "token=" is reserved for credentials by the shared log redactor.
    const report = `Node integrity: pid=${integrity.pid}, process=${tokenText}; EXE=${fileText}`;

    if (
        token.status === 'error' ||
        file.status === 'error' ||
        hasLowProcessIntegrity(integrity) ||
        (file.label && file.label.rid < 8192)
    ) {
        log.warn(report);
    } else {
        log.info(report);
    }
}
