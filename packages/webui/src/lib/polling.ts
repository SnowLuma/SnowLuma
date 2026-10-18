/** Run immediately, then at the requested cadence without overlapping requests. */
export function startPolling(
    refresh: () => Promise<unknown>,
    intervalMs: number,
    pauseWhenHidden = true,
): () => void {
    let running = false;

    const tick = async () => {
        if (running || (pauseWhenHidden && document.hidden)) {
            return;
        }

        running = true;

        try {
            await refresh();
        } finally {
            running = false;
        }
    };

    void tick();
    const interval = intervalMs > 0 ? setInterval(tick, intervalMs) : null;

    const onVisible = () => {
        if (!document.hidden) {
            void tick();
        }
    };

    if (pauseWhenHidden) {
        document.addEventListener('visibilitychange', onVisible);
    }

    return () => {
        if (interval !== null) {
            clearInterval(interval);
        }

        if (pauseWhenHidden) {
            document.removeEventListener('visibilitychange', onVisible);
        }
    };
}
