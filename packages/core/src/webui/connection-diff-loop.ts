import { createLogger, runWithTraceRequest } from '@snowluma/common/logger';
import { renderParamsVerbose } from '@snowluma/common/log-summary';
import type { StateBus } from './state-bus';

const log = createLogger('WebUI.Connections');

export interface ConnectionDiffLoopOptions {
    bus: StateBus;
    /** Read the current adapter-status snapshot for every live UIN. */
    getSnapshot: () => unknown;
    /** Optional projector — return the "comparable" subset of the snapshot.
     *  The full snapshot is what the SSE handler ships to the WebUI; this
     *  projection is what the diff loop compares between ticks. Use it to
     *  strip volatile fields (e.g. HH:MM:SS timestamps embedded in adapter
     *  `detail` strings) that would otherwise produce a publish every tick
     *  under any active webhook — defeating the loop's whole purpose.
     *  Default: identity. */
    pickComparable?: (snapshot: unknown) => unknown;
    /** Poll cadence in milliseconds; default 500. */
    intervalMs?: number;
}

/** One shared loop while clients subscribe; each subscription returns its release handle. */
export function createConnectionPoller(opts: ConnectionDiffLoopOptions): () => () => void {
    const intervalMs = opts.intervalMs ?? 500;
    let lastSerialized: string | undefined | null = null;
    let subscribers = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    // One-shot diagnostic latch: a projector that starts throwing only after
    // a shape regression would otherwise wedge the baseline silently — no
    // publishes, no log, no symptom besides "the dashboard's connections
    // card stops updating". Surface it ONCE so the failure is visible.
    let warnedSnapshotThrew = false;
    let warnedProjectorThrew = false;

    const tick = (): void => {
        if (subscribers === 0) {
            return;
        }

        let snap: unknown;

        try {
            snap = opts.getSnapshot();
        } catch (err) {
            if (!warnedSnapshotThrew) {
                warnedSnapshotThrew = true;
                runWithTraceRequest(() => {
                    const startedAt = Date.now();
                    log.trace('connection_diff_start phase=snapshot_read');
                    log.trace(
                        'connection_diff_terminal outcome=failed reason=snapshot_failed error=%j elapsedMs=%d',
                        err instanceof Error ? err.message : String(err),
                        Date.now() - startedAt,
                    );
                });
            }

            // Snapshot read failed (e.g. mid-shutdown). Skip this tick; the
            // next one will retry. Don't reset the baseline so we don't
            // spuriously republish when the snapshot starts working again.
            return;
        }

        let comparable: unknown;

        try {
            comparable = opts.pickComparable ? opts.pickComparable(snap) : snap;
        } catch (err) {
            // A buggy projector must not crash the diff loop or wedge baseline.
            // But silent wedge is its own bug class — log the FIRST occurrence
            // so an operator can find it without re-running the loop locally.
            if (!warnedProjectorThrew) {
                warnedProjectorThrew = true;
                log.error(
                    'connection snapshot projector failed; updates may be stale: %s',
                    err instanceof Error ? err.message : String(err),
                );
                runWithTraceRequest(() => {
                    const startedAt = Date.now();
                    log.trace(() => [
                        'connection_diff_start phase=project snapshot=%s',
                        renderParamsVerbose(snap),
                    ]);
                    log.trace(
                        'connection_diff_terminal outcome=failed reason=projector_failed error=%j elapsedMs=%d',
                        err instanceof Error ? err.message : String(err),
                        Date.now() - startedAt,
                    );
                });
            }

            return;
        }

        const serialized = JSON.stringify(comparable);

        if (lastSerialized === null) {
            // First successful observation. The SSE handler's sendAllInitial
            // already shipped a `connections` frame to every connected client
            // on connect, so the baseline is what they already have — emitting
            // it again would be a duplicate. Just store it.
            lastSerialized = serialized;
            return;
        }

        if (serialized === lastSerialized) {
            return;
        }

        lastSerialized = serialized;
        runWithTraceRequest(() => {
            const startedAt = Date.now();
            log.trace(() => ['connection_diff_start snapshot=%s', renderParamsVerbose(snap)]);
            log.trace('connection_diff_branch branch=publish resource=connections');
            opts.bus.publish('connections');
            log.trace(
                'connection_diff_terminal outcome=completed reason=published elapsedMs=%d',
                Date.now() - startedAt,
            );
        });
    };

    return () => {
        if (subscribers++ === 0) {
            lastSerialized = null;
            tick();
            timer = setInterval(tick, intervalMs);
            timer.unref();
        }

        let subscribed = true;

        return () => {
            if (!subscribed) {
                return;
            }

            subscribed = false;

            if (--subscribers === 0 && timer !== null) {
                clearInterval(timer);
                timer = null;
                lastSerialized = null;
            }
        };
    };
}
