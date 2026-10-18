import { StateBus } from './state-bus';
import type { BridgeSessionSource } from '../bridge/bridge-interface';

export interface StateWiring {
    readonly bus: StateBus;
    onSessionsChanged(): void;
    dispose(): void;
}

export function createStateWiring(bridgeManager: BridgeSessionSource): StateWiring {
    const bus = new StateBus();

    const publishAccountChange = (): void => {
        bus.publish('qq-list');
        bus.publish('connections');
    };

    const unsubscribe = bridgeManager.subscribeSessions({
        started: publishAccountChange,
        closed: publishAccountChange,
    });

    return {
        bus,
        onSessionsChanged: () => bus.publish('processes'),
        dispose(): void {
            bus.dispose();
            unsubscribe();
        },
    };
}
