import { createLogger } from '@snowluma/common/logger';

const log = createLogger('WebUI.State');

export type StateResource = 'processes' | 'qq-list' | 'connections';

export type StateListener = (resource: StateResource) => void;

export class StateBus {
    private readonly listeners = new Set<StateListener>();
    private disposed = false;

    /** Subscribe to every publish; returns an unsubscribe handle. Calling
     *  the handle more than once is a no-op. */
    subscribe(listener: StateListener): () => void {
        if (this.disposed) {
            return () => undefined;
        }

        this.listeners.add(listener);
        let active = true;

        return () => {
            if (!active) {
                return;
            }

            active = false;
            this.listeners.delete(listener);
        };
    }

    /** Notify every CURRENTLY-subscribed listener that `resource` is stale.
     *  Iterates a frozen snapshot of the subscriber set so add/remove during
     *  the emit don't change which listeners see THIS publish; subscriber
     *  exceptions are isolated and do not abort the fan-out. */
    publish(resource: StateResource): void {
        if (this.disposed) {
            return;
        }

        const snapshot = [...this.listeners];

        for (const fn of snapshot) {
            try {
                fn(resource);
            } catch (error) {
                log.warn(
                    'state listener failed: resource=%s error=%s',
                    resource,
                    error instanceof Error ? error.message : String(error),
                );
            }
        }
    }

    /** Drop every subscriber and refuse future subscribes / publishes. */
    dispose(): void {
        this.disposed = true;
        this.listeners.clear();
    }
}
