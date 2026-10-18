import { createLogger } from '@snowluma/common/logger';
import type { QQEventVariant } from './events';

type EventKind = QQEventVariant['kind'];
type EventOf<K extends EventKind> = Extract<QQEventVariant, { kind: K }>;

export type EventHandler<K extends EventKind> = (event: EventOf<K>) => void | Promise<void>;
export type AnyEventHandler = (event: QQEventVariant) => void | Promise<void>;

export interface EventBusOptions {
    /** Logger label for handler failures. Defaults to `Bridge.Events`. */
    loggerName?: string;
    /** Override the default error reporter (e.g. for tests). */
    onError?: (kind: EventKind | '*', err: unknown) => void;
}

const DEFAULT_LOGGER = createLogger('Bridge.Events');

export class BridgeEventBus {
    private readonly handlers = new Map<EventKind, Set<{ handler: unknown }>>();
    private readonly anyHandlers = new Set<{ handler: AnyEventHandler }>();
    private readonly onError: (kind: EventKind | '*', err: unknown) => void;

    constructor(opts: EventBusOptions = {}) {
        if (opts.onError) {
            this.onError = opts.onError;
        } else {
            const log = opts.loggerName ? createLogger(opts.loggerName) : DEFAULT_LOGGER;

            this.onError = (kind, err) => {
                log.error(
                    'event handler error [%s]: %s',
                    kind,
                    err instanceof Error ? (err.stack ?? err.message) : String(err),
                );
            };
        }
    }

    /** Each subscription owns its unsubscribe function. */
    on<K extends EventKind>(kind: K, handler: EventHandler<K>): () => void {
        let set = this.handlers.get(kind);

        if (!set) {
            set = new Set();
            this.handlers.set(kind, set);
        }

        const subscription = { handler };
        set.add(subscription);

        return () => {
            this.handlers.get(kind)?.delete(subscription);
        };
    }

    /** Subscribe to every kind (low-volume callers like loggers). */
    onAny(handler: AnyEventHandler): () => void {
        const subscription = { handler };
        this.anyHandlers.add(subscription);

        return () => {
            this.anyHandlers.delete(subscription);
        };
    }

    /** Remove every registration of this handler for the given kind. */
    off<K extends EventKind>(kind: K, handler: EventHandler<K>): void {
        const subscriptions = this.handlers.get(kind);

        if (subscriptions) {
            for (const subscription of subscriptions) {
                if (subscription.handler === handler) {
                    subscriptions.delete(subscription);
                }
            }
        }
    }

    has(kind: EventKind): boolean {
        return (this.handlers.get(kind)?.size ?? 0) + this.anyHandlers.size > 0;
    }

    /** Drop every subscriber. Mostly useful for tests. */
    clear(): void {
        this.handlers.clear();
        this.anyHandlers.clear();
    }

    /**
     * Dispatch an event in parallel to every subscriber for its kind plus every
     * onAny handler. Rejections are isolated per-handler — one bad subscriber
     * never blocks the others, and the returned promise resolves once every
     * subscriber settles. Subscription changes apply to the next event.
     */
    async emit<K extends EventKind>(event: EventOf<K>): Promise<void> {
        const kindHandlers = [...(this.handlers.get(event.kind) ?? [])];
        const anyHandlers = [...this.anyHandlers];
        const tasks: Promise<void>[] = [];

        for (const { handler } of kindHandlers) {
            // Registration keys guarantee this handler accepts the event's kind.
            const typed = handler as EventHandler<K>;
            tasks.push(invoke(this.onError, event.kind, () => typed(event)));
        }

        for (const { handler } of anyHandlers) {
            tasks.push(invoke(this.onError, '*', () => handler(event)));
        }

        await Promise.allSettled(tasks);
    }
}

async function invoke(
    onError: (kind: EventKind | '*', err: unknown) => void,
    kind: EventKind | '*',
    fn: () => unknown,
): Promise<void> {
    try {
        await fn();
    } catch (err) {
        onError(kind, err);
    }
}
