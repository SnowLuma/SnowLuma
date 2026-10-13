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
    let timedOut = false;
    let externallyAborted = false;

    const onExternalAbort = (): void => {
        externallyAborted = true;
        controller.abort(externalSignal?.reason);
    };

    if (externalSignal?.aborted) {
        onExternalAbort();
    } else {
        externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    }

    const timer =
        timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true;
                  controller.abort();
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
            return timedOut;
        },
        isExternallyAborted() {
            return externallyAborted || externalSignal?.aborted === true;
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
        (error as { name?: unknown }).name === 'AbortError'
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

    throwIfAborted(signal, message);

    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            reject(new SnowLumaAbortError(message, { cause: signal.reason }));
        };

        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
        });
    });
}
