import { errorMessage } from '@snowluma/common/errors';
import { createLogger, type Logger } from '@snowluma/common/logger';
import type { HookProcessBaseInfo } from './injector';

export interface ProcessEnumerator {
    /** null means unknown: keep the previous process set. */
    enumerate(): Promise<HookProcessBaseInfo[] | null>;
    dispose(): void;
}

interface ProcessEnumeratorDeps {
    listProcesses: () => Promise<HookProcessBaseInfo[]>;
    timeoutMs?: number;
    log?: Logger;
}

export function createProcessEnumerator(deps: ProcessEnumeratorDeps): ProcessEnumerator {
    const log = deps.log ?? createLogger('ProcessEnumerator');
    const timeoutMs = deps.timeoutMs ?? 4000;
    let disposed = false;
    let pending: {
        promise: Promise<HookProcessBaseInfo[] | null>;
        settle: (result: HookProcessBaseInfo[] | null) => void;
    } | null = null;

    return {
        enumerate() {
            if (disposed) {
                return Promise.resolve(null);
            }

            if (pending) {
                return pending.promise;
            }

            let resolve!: (result: HookProcessBaseInfo[] | null) => void;
            const promise = new Promise<HookProcessBaseInfo[] | null>((done) => {
                resolve = done;
            });

            const settle = (result: HookProcessBaseInfo[] | null) => {
                clearTimeout(timer);
                resolve(result);
            };

            const timer = setTimeout(() => {
                log.warn(
                    'process enumeration timed out after %dms; keeping prior process set',
                    timeoutMs,
                );
                settle(null);
            }, timeoutMs);
            pending = { promise, settle };

            // A timeout ends the wait, not the native call. Keep its slot until it
            // finishes so subsequent polls cannot accumulate blocked native work.
            void Promise.resolve()
                .then(() => (disposed ? null : deps.listProcesses()))
                .then(
                    (processes) => {
                        pending = null;
                        settle(disposed ? null : processes);
                    },
                    (error) => {
                        pending = null;
                        log.warn('process enumeration failed: %s', errorMessage(error));
                        settle(null);
                    },
                );
            return promise;
        },
        dispose() {
            disposed = true;
            pending?.settle(null);
        },
    };
}
