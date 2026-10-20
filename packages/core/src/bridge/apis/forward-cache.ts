import { createLogger } from '@snowluma/common/logger';
import type { ForwardNodePayload } from '@snowluma/protocol/events';

const MAX_CACHED_FORWARDS = 512;
const log = createLogger('Bridge.Forward');
type ForwardLayers = Map<string, ForwardNodePayload[]>;

interface ForwardCacheHit {
    rootId: string;
    resId: string;
    layers: ForwardLayers;
    nodes: ForwardNodePayload[];
}

/** Nested results share the lifetime and recency of the result that supplied them. */
export class ForwardResultCache {
    private readonly entries = new Map<string, ForwardLayers>();

    get(resId: string): ForwardCacheHit | undefined {
        let hit: ForwardCacheHit | undefined;

        // A nested result can be supplied by several retained outer results.
        for (const [rootId, layers] of this.entries) {
            const nodes = layers.get(resId);

            if (nodes) {
                hit = { rootId, resId, layers, nodes };
            }
        }

        if (hit) {
            this.entries.delete(hit.rootId);
            this.entries.set(hit.rootId, hit.layers);
        }

        return hit;
    }

    set(rootId: string, layers: ReadonlyMap<string, ForwardNodePayload[]>): void {
        if (!layers.has(rootId)) {
            throw new Error('forward cache entry is missing its outer result');
        }

        this.entries.delete(rootId);
        this.entries.set(rootId, new Map(layers));

        while (this.entries.size > MAX_CACHED_FORWARDS) {
            const oldest = this.entries.entries().next().value!;
            this.entries.delete(oldest[0]);
            log.trace(
                'forward cache evicted: res_id=%s layers=%d remaining=%d',
                oldest[0],
                oldest[1].size,
                this.entries.size,
            );
        }
    }

    update(hit: ForwardCacheHit, nodes: ForwardNodePayload[]): void {
        // Enrichment may finish after eviction or replacement. It must not revive
        // an old result or turn a nested result into an independent cache entry.
        if (
            this.entries.get(hit.rootId) === hit.layers &&
            hit.layers.get(hit.resId) === hit.nodes
        ) {
            hit.layers.set(hit.resId, nodes);
        }
    }
}
