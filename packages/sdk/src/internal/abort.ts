import { SnowLumaAbortError } from '../errors';

export interface RequestAbortState {
    signal: AbortSignal;
    cleanup(): void;
    isTimedOut(): boolean;
    isExternallyAborted(): boolean;
}

export function createRequestAbortState(
    timeoutMs: number,
    externalSignal?: AbortSignal,
): RequestAbortState {
    const controller = new AbortController();
    let abortedBy: 'timeout' | 'external' | null = null;

    const abort = (source: 'timeout' | 'external', reason?: unknown): void => {
        if (abortedBy !== null) {
            return;
        }

        abortedBy = source;
        controller.abort(reason);
    };

    const onExternalAbort = (): void => {
        abort('external', externalSignal?.reason);
    };

    if (externalSignal?.aborted) {
        onExternalAbort();
    } else {
        externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    }

    const timer =
        timeoutMs > 0
            ? setTimeout(() => {
                  abort('timeout');
              }, timeoutMs)
            : null;

    return {
        signal: controller.signal,
        cleanup() {
            if (timer) {
                clearTimeout(timer);
            }

            externalSignal?.removeEventListener('abort', onExternalAbort);
        },
        isTimedOut() {
            return abortedBy === 'timeout';
        },
        isExternallyAborted() {
            return abortedBy === 'external';
        },
    };
}

export function throwIfAborted(signal?: AbortSignal, message = 'SnowLuma request aborted'): void {
    if (signal?.aborted) {
        throw new SnowLumaAbortError(message, { cause: signal.reason });
    }
}

export function isAbortError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'AbortError'
    );
}

export function raceWithAbort<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
    message = 'SnowLuma request aborted',
): Promise<T> {
    if (!signal) {
        return promise;
    }

    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
            reject(new SnowLumaAbortError(message, { cause: signal.reason }));
        };

        if (signal.aborted) {
            onAbort();
        } else {
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
    return Promise.race([aborted, promise]).finally(() => {
        signal.removeEventListener('abort', onAbort);
    });
}
