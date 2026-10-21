import {
    defaultWebuiPresentation,
    parseWebuiPresentation,
    type WebuiPresentation,
    type WebuiTarget,
} from '@snowluma/common/webui-target';

/** Synchronous snapshots avoid stale async style loads winning a rapid host theme change. */
export function createPresentationStore(target: WebuiTarget | null) {
    let snapshot: WebuiPresentation | null = target ? defaultWebuiPresentation(target) : null;
    const listeners = new Set<() => void>();

    return {
        target,
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
            if (target) {
                listeners.add(listener);
            }

            return () => {
                listeners.delete(listener);
            };
        },
        receive(value: unknown) {
            // Host code cannot opt a standalone deployment into a target.
            if (target === null) {
                return;
            }

            const update = parseWebuiPresentation(value);

            if (update.target !== null && update.target !== target) {
                throw new Error(
                    `Host appearance target does not match deployment target ${target}`,
                );
            }

            const next = update.target === null ? null : update;

            if (JSON.stringify(next) === JSON.stringify(snapshot)) {
                return;
            }

            snapshot = next;
            listeners.forEach((listener) => listener());
        },
    };
}

export type PresentationStore = ReturnType<typeof createPresentationStore>;
