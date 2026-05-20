import { createLogger } from '../utils/logger';
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
  // Per-kind subscribers are stored as `Set<unknown>` so the container
  // doesn't carry a contravariant function type that fights TS variance
  // rules. The runtime invariant is straightforward: handlers stored under
  // key `K` only ever see `EventOf<K>` events, which is what the single
  // narrowing cast at the dispatch site below relies on.
  private readonly handlers = new Map<EventKind, Set<unknown>>();
  private readonly anyHandlers = new Set<AnyEventHandler>();
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

  /** Subscribe to one kind. Returns an unsubscribe function. */
  on<K extends EventKind>(kind: K, handler: EventHandler<K>): () => void {
    let set = this.handlers.get(kind);
    if (!set) {
      set = new Set();
      this.handlers.set(kind, set);
    }
    set.add(handler);
    return () => {
      this.handlers.get(kind)?.delete(handler);
    };
  }

  /** Subscribe to every kind (low-volume callers like loggers). */
  onAny(handler: AnyEventHandler): () => void {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  off<K extends EventKind>(kind: K, handler: EventHandler<K>): void {
    this.handlers.get(kind)?.delete(handler);
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
   * subscriber settles.
   */
  async emit<K extends EventKind>(event: EventOf<K>): Promise<void> {
    const kindHandlers = this.handlers.get(event.kind);
    if ((!kindHandlers || kindHandlers.size === 0) && this.anyHandlers.size === 0) {
      return;
    }
    const tasks: Promise<unknown>[] = [];
    if (kindHandlers) {
      for (const handler of kindHandlers) {
        // Single narrowing cast — the only place we re-assert that handlers
        // stored under `event.kind` accept `EventOf<event.kind>` events.
        const typed = handler as EventHandler<K>;
        tasks.push(invoke(this.onError, event.kind, () => typed(event)));
      }
    }
    for (const handler of this.anyHandlers) {
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
    const ret = fn();
    if (ret && typeof (ret as Promise<unknown>).then === 'function') {
      await ret;
    }
  } catch (err) {
    onError(kind, err);
  }
}
