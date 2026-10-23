import type { TransferProgress } from './client.js';

/** One reporter per request. No timers or notifications survive the request. */
export function createProgressReporter(
    send: (progress: TransferProgress) => Promise<void>,
    signal: AbortSignal,
    now: () => number = Date.now,
) {
    let latest: TransferProgress | undefined;
    let sent = -1;
    let sentAt = -Infinity;

    const flush = async (): Promise<void> => {
        if (!latest || latest.progress <= sent || signal.aborted) {
            return;
        }

        await send(latest);
        sent = latest.progress;
        sentAt = now();
    };

    return {
        async report(progress: TransferProgress): Promise<void> {
            if (
                !Number.isFinite(progress.progress) ||
                progress.progress < (latest?.progress ?? 0) ||
                (progress.total !== undefined &&
                    (!Number.isFinite(progress.total) ||
                        progress.total <= 0 ||
                        progress.progress > progress.total))
            ) {
                throw new Error('Invalid transfer progress');
            }

            latest = progress;

            if (now() - sentAt >= 250) {
                await flush();
            }
        },
        finish: flush,
    };
}
