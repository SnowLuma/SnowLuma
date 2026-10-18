import { StateBus } from './state-bus';
import type { BridgeManager } from '../bridge/manager';

export interface StateWiring {
    /** The bus the SSE handler subscribes to. */
    readonly bus: StateBus;
    /** Pass as the HookManager `onSessionsChanged` dep — publishes 'processes'. */
    onSessionsChanged: () => void;
    /** Replace the bridge subscription for account and connection invalidations. */
    bindBridgeManager(bm: BridgeManager): void;
    /** Unsubscribe and stop publishing. */
    dispose(): void;
}

export function createStateWiring(): StateWiring {
    const bus = new StateBus();
    let subscriptions: (() => void)[] | null = [];

    const publishAccount = (): void => {
        // Publish the account list before its adapters are enumerated.
        bus.publish('qq-list');
        bus.publish('connections');
    };

    return {
        bus,
        onSessionsChanged: () => bus.publish('processes'),
        bindBridgeManager(bm: BridgeManager): void {
            if (!subscriptions) {
                return;
            }

            subscriptions.forEach((unsubscribe) => unsubscribe());
            subscriptions = [
                bm.addSessionStartedListener(publishAccount),
                bm.addSessionClosedListener(publishAccount),
            ];
        },
        dispose(): void {
            subscriptions?.forEach((unsubscribe) => unsubscribe());
            subscriptions = null;
            bus.dispose();
        },
    };
}
