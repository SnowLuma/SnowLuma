export interface HistoryRequestGateClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const SYSTEM_CLOCK: HistoryRequestGateClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => abortableSleep(ms, signal),
};

/**
 * Process-wide history request gate.
 *
 * The gate owns the network operation, not just a preceding delay. This keeps
 * concurrent history callers serialized and preserves the stricter spacing on
 * both sides of an automatic history-sync request.
 */
export class HistoryRequestGate {
  private tail: Promise<void> = Promise.resolve();
  private lastStartedAt: number | null = null;
  private nextAllowedAt = 0;

  constructor(private readonly clock: HistoryRequestGateClock = SYSTEM_CLOCK) {}

  run<T>(
    minimumGapMs: number,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!Number.isSafeInteger(minimumGapMs) || minimumGapMs < 0) {
      return Promise.reject(new Error(`history request gap is invalid: ${String(minimumGapMs)}`));
    }

    let operationStarted = false;
    const result = this.tail.then(async () => {
      throwIfAborted(signal);
      const now = this.clock.now();
      const requestedBoundary = this.lastStartedAt === null
        ? now
        : this.lastStartedAt + minimumGapMs;
      const wait = Math.max(this.nextAllowedAt, requestedBoundary) - now;
      if (wait > 0) await this.clock.sleep(wait, signal);

      throwIfAborted(signal);
      const startedAt = this.clock.now();
      this.lastStartedAt = startedAt;
      this.nextAllowedAt = startedAt + minimumGapMs;
      operationStarted = true;
      return operation();
    });

    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return signal
      ? rejectWhileQueuedOnAbort(result, signal, () => operationStarted)
      : result;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('history request aborted');
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new Error('history request aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function rejectWhileQueuedOnAbort<T>(
  result: Promise<T>,
  signal: AbortSignal,
  hasStarted: () => boolean,
): Promise<T> {
  if (signal.aborted && !hasStarted()) {
    return Promise.reject(signal.reason ?? new Error('history request aborted'));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!hasStarted()) {
        reject(signal.reason ?? new Error('history request aborted'));
      }
    };
    signal.addEventListener('abort', onAbort);
    result.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
