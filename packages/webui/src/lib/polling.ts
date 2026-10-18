/** Wait between requests; keep no timer while hidden or awaiting a response. */
export function startPolling(
    refresh: () => Promise<unknown>,
    intervalMs: number,
    pauseWhenHidden = true,
): () => void {
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const paused = () => pauseWhenHidden && document.hidden;

    const clearTimer = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const tick = async () => {
        if (stopped || running || paused()) {
            return;
        }

        running = true;

        try {
            await refresh();
        } catch (error) {
            console.error('polling failed', error);
        } finally {
            running = false;

            if (!stopped && !paused() && intervalMs > 0) {
                timer = setTimeout(() => {
                    timer = null;
                    void tick();
                }, intervalMs);
            }
        }
    };

    void tick();

    const onVisibilityChange = () => {
        clearTimer();

        if (!document.hidden) {
            void tick();
        }
    };

    if (pauseWhenHidden) {
        document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
        stopped = true;
        clearTimer();

        if (pauseWhenHidden) {
            document.removeEventListener('visibilitychange', onVisibilityChange);
        }
    };
}
