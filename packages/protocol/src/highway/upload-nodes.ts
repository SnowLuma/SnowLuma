import type { BridgeContext } from '../bridge-context';
import type { HighwayServer } from './highway-client';

const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;
const MAX_OBSERVATIONS = 128;

interface Observation {
    succeeded: boolean;
    expiresAt: number;
}

/** Short-lived scheduling evidence, never credentials or additional upload destinations. */
export class UploadNodeHistory {
    private readonly observations = new Map<string, Observation>();

    private key(commandId: number, server: HighwayServer): string {
        return JSON.stringify([commandId, server.host, server.port]);
    }

    private prune(now: number): void {
        for (const [key, observation] of this.observations) {
            if (observation.expiresAt <= now) {
                this.observations.delete(key);
            }
        }
    }

    order(commandId: number, candidates: readonly HighwayServer[]): HighwayServer[] {
        this.prune(Date.now());
        const unique = new Map(candidates.map((server) => [this.key(commandId, server), server]));

        const rank = (server: HighwayServer): number => {
            const observation = this.observations.get(this.key(commandId, server));
            return observation ? (observation.succeeded ? 0 : 2) : 1;
        };

        // Stable ties retain server-provided order. Failed endpoints remain eligible:
        // a temporary observation must not permanently exclude the only working node.
        return [...unique.values()].sort((a, b) => rank(a) - rank(b));
    }

    record(commandId: number, server: HighwayServer, succeeded: boolean): void {
        const now = Date.now();
        this.prune(now);
        const key = this.key(commandId, server);
        this.observations.delete(key);
        this.observations.set(key, {
            succeeded,
            expiresAt: now + (succeeded ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
        });

        if (this.observations.size > MAX_OBSERVATIONS) {
            const oldest = this.observations.keys().next();

            if (!oldest.done) {
                this.observations.delete(oldest.value);
            }
        }
    }
}

// IdentityService belongs to one account's Bridge. Weak ownership also releases
// observations when that account session is discarded, without a global UIN registry.
const histories = new WeakMap<
    BridgeContext['identity'],
    { uin: string; history: UploadNodeHistory }
>();

export function uploadNodeHistory(identity: BridgeContext['identity']): UploadNodeHistory {
    let entry = histories.get(identity);

    if (!entry || entry.uin !== identity.uin) {
        entry = { uin: identity.uin, history: new UploadNodeHistory() };
        histories.set(identity, entry);
    }

    return entry.history;
}
