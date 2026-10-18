import { errorMessage } from '@snowluma/common/errors';
import { createLogger } from '@snowluma/common/logger';
import type { StateBus, StateResource } from './state-bus';

const log = createLogger('WebUI.StateStream');

export interface StateStreamFrame {
    resource: StateResource;
    data: unknown;
}

export interface BindStateStreamOptions {
    bus: StateBus;
    /** Read the current snapshot for one resource. May be sync or async. */
    snapshot: (resource: StateResource) => unknown | Promise<unknown>;
    /** Receive a fresh frame; called once per debounced publish.
     *  Exceptions are caught — a dead controller must not abort the bus
     *  subscription or break sibling resources. */
    send: (frame: StateStreamFrame) => void;
    /** Coalesce window in milliseconds; default 50. */
    debounceMs?: number;
}

export interface StateStreamHandle {
    /** Emit one frame per resource using the current snapshot. Use on connect. */
    sendAllInitial(): Promise<void>;
    /** Stop subscribing + cancel pending timers. Subsequent bus publishes
     *  produce nothing through this binding. */
    dispose(): void;
}

const ALL_RESOURCES: readonly StateResource[] = ['processes', 'qq-list', 'connections'];

export function bindStateStream(opts: BindStateStreamOptions): StateStreamHandle {
    const debounceMs = opts.debounceMs ?? 50;
    let disposed = false;

    function resourceStream(resource: StateResource) {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let task: Promise<void> | null = null;
        let pending = false;

        function clearTimer() {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
        }

        function flush(): Promise<void> {
            if (disposed) {
                return Promise.resolve();
            }

            if (task) {
                return task;
            }

            clearTimer();
            task = Promise.resolve()
                .then(async () => {
                    if (disposed) {
                        return;
                    }

                    const data = await opts.snapshot(resource);

                    if (!disposed) {
                        opts.send({ resource, data });
                    }
                })
                .catch((error) => {
                    log.warn('state stream %s failed: %s', resource, errorMessage(error));
                })
                .finally(() => {
                    task = null;

                    if (pending) {
                        pending = false;
                        schedule();
                    }
                });
            return task;
        }

        function schedule(): void {
            if (disposed) {
                return;
            }

            if (task) {
                pending = true;
                return;
            }

            clearTimer();
            timer = setTimeout(() => void flush(), debounceMs);
        }

        return { flush, schedule, clearTimer };
    }

    const streams = {
        processes: resourceStream('processes'),
        'qq-list': resourceStream('qq-list'),
        connections: resourceStream('connections'),
    };
    const unsubscribe = opts.bus.subscribe((resource) => streams[resource].schedule());

    return {
        async sendAllInitial(): Promise<void> {
            await Promise.all(ALL_RESOURCES.map((resource) => streams[resource].flush()));
        },
        dispose(): void {
            disposed = true;
            unsubscribe();
            ALL_RESOURCES.forEach((resource) => streams[resource].clearTimer());
        },
    };
}
