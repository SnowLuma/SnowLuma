/**
 * State-wiring — couples the publisher edges (HookManager session events,
 * BridgeManager session-started / session-closed) to a fresh StateBus so the
 * `/api/state/stream` SSE handler can push snapshot invalidations to the
 * WebUI without REST polling.
 *
 * Decoupling rationale:
 *   - HookManager owns the per-process state-machine; it knows when a
 *     session's `listProcesses()` view changes. We feed it `onSessionsChanged`
 *     (callable from outside the bridge package) so this file is the ONLY
 *     place that imports both the bus and HookManager's dep shape.
 *   - BridgeManager fires `session-started` / `session-closed` listeners on
 *     account edges (the OneBot instance list mutates around these). We add
 *     listeners directly so `qq-list` + `connections` invalidate at the right
 *     moment without modifying BridgeManager.
 *
 * `dispose()` unwires everything so a test (or a future hot-reload) can
 * recreate the wiring without leaking listeners.
 */

import { StateBus } from './state-bus';
import type { BridgeManager } from '../bridge/manager';

export interface StateWiring {
  /** The bus the SSE handler subscribes to. */
  readonly bus: StateBus;
  /** Pass as the HookManager `onSessionsChanged` dep — publishes 'processes'. */
  onSessionsChanged: () => void;
  /** Hook into a BridgeManager so its session edges publish 'qq-list' and
   *  'connections'. Can be called at most once per wiring (subsequent calls
   *  add duplicate listeners). */
  bindBridgeManager(bm: BridgeManager): void;
  /** Drop every listener + neuter the bus so further publishes do nothing. */
  dispose(): void;
}

export function createStateWiring(): StateWiring {
  const bus = new StateBus();
  let disposed = false;

  const publish = (resource: Parameters<StateBus['publish']>[0]): void => {
    if (disposed) return;
    bus.publish(resource);
  };

  return {
    bus,
    onSessionsChanged: () => publish('processes'),
    bindBridgeManager(bm: BridgeManager): void {
      // Account appeared: the qq-list response gains an entry and the
      // connections response gains the new account's adapter row. Two
      // distinct resource invalidations, in source-of-truth order
      // (account exists → only then can adapters be enumerated for it).
      bm.addSessionStartedListener(() => {
        publish('qq-list');
        publish('connections');
      });
      // Account disappeared: same two resources shrink, same order so a
      // racy WebUI receiving both events independently sees the qq-list
      // shrink before it tries to render connections for a uin that's
      // about to vanish.
      bm.addSessionClosedListener(() => {
        publish('qq-list');
        publish('connections');
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      bus.dispose();
    },
  };
}
