import { errorMessage } from '@snowluma/common/errors';
import { createLogger, type Logger } from '@snowluma/common/logger';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { HookProcessBaseInfo } from './injector';

const DEFAULT_INTERVAL_MS = 1500;
const MIN_INTERVAL_MS = 250;

export type PipeWatcherDeps = {
    /** Failed enumeration returns null and preserves the last known snapshot. */
    listProcesses: () => Promise<HookProcessBaseInfo[] | null>;
    /** Linux uses this snapshot to locate each target user's runtime directory. */
    listLivePipes: (processes: readonly HookProcessBaseInfo[]) => Promise<Set<number>>;
    intervalMs?: number;
    log?: Logger;
};

type PipeEvent =
    | ['process-discovered', HookProcessBaseInfo]
    | ['pipe-up' | 'pipe-down' | 'process-gone', number];

/** Publishes process and pipe snapshots, then emits their ordered differences. */
export class PipeWatcher extends EventEmitter {
    private readonly listProcesses: PipeWatcherDeps['listProcesses'];
    private readonly listLivePipes: PipeWatcherDeps['listLivePipes'];
    private readonly intervalMs: number;
    private readonly log: Logger;
    private livePipes = new Set<number>();
    private knownPids = new Set<number>();
    private timer: NodeJS.Timeout | null = null;
    private tickTask: Promise<void> | null = null;
    private pendingTick = false;
    private startPromise: Promise<void> | null = null;
    private stopped = false;

    constructor(deps: PipeWatcherDeps) {
        super();
        this.listProcesses = deps.listProcesses;
        this.listLivePipes = deps.listLivePipes;
        this.intervalMs = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
        this.log = deps.log ?? createLogger('PipeWatcher');
    }

    isPipeLive(pid: number): boolean {
        return this.livePipes.has(pid);
    }

    isProcessAlive(pid: number): boolean {
        return this.knownPids.has(pid);
    }

    /** Read the initial snapshot and start polling. Repeated calls share startup. */
    start(): Promise<void> {
        return (this.startPromise ??= this.tickNow().finally(() => {
            this.scheduleNext(this.intervalMs);
        }));
    }

    /** Coalesce wake requests into one scan after the current read. */
    wake(): void {
        if (this.stopped) {
            return;
        }

        if (this.tickTask) {
            this.pendingTick = true;
        } else {
            this.scheduleNext(0);
        }
    }

    /** Wait for a fresh snapshot, including a scan queued behind an active read. */
    tickNow(): Promise<void> {
        if (this.stopped) {
            return Promise.resolve();
        }

        if (this.tickTask) {
            this.pendingTick = true;
            return this.tickTask;
        }

        this.tickTask = (async () => {
            do {
                this.pendingTick = false;
                await this.readSnapshot();

                if (this.pendingTick && !this.stopped) {
                    await nextTurn();
                }
            } while (this.pendingTick && !this.stopped);
        })().finally(() => {
            this.tickTask = null;
        });
        return this.tickTask;
    }

    stop(): void {
        this.stopped = true;
        this.pendingTick = false;

        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    dispose(): void {
        this.stop();
        this.removeAllListeners();
    }

    private scheduleNext(delayMs: number): void {
        if (this.stopped) {
            return;
        }

        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(() => {
            this.timer = null;
            void this.tickAndReschedule();
        }, delayMs);
    }

    private async tickAndReschedule(): Promise<void> {
        try {
            await this.tickNow();
        } catch (error) {
            this.log.warn('poll failed: %s', errorMessage(error));
        } finally {
            this.scheduleNext(this.intervalMs);
        }
    }

    private async readSnapshot(): Promise<void> {
        let processes: HookProcessBaseInfo[] | null;

        try {
            processes = await this.listProcesses();
        } catch (error) {
            this.log.warn('listProcesses failed: %s', errorMessage(error));
            processes = null;
        }

        if (this.stopped) {
            return;
        }

        if (processes === null) {
            // Missing data must not disconnect healthy sessions. Reconnect retries
            // still run against the last known snapshot (issue #158).
            this.emit('tick');
            return;
        }

        let livePipes: Set<number>;

        try {
            livePipes = await this.listLivePipes(processes);
        } catch (error) {
            this.log.warn('listLivePipes failed: %s', errorMessage(error));
            livePipes = this.livePipes;
        }

        if (this.stopped) {
            return;
        }

        const knownPids = new Set(processes.map(({ pid }) => pid));
        const currentPipes = new Set([...livePipes].filter((pid) => knownPids.has(pid)));
        const events: PipeEvent[] = [];

        for (const process of processes) {
            if (!this.knownPids.has(process.pid)) {
                events.push(['process-discovered', process]);
            }
        }

        for (const pid of currentPipes) {
            if (!this.livePipes.has(pid)) {
                events.push(['pipe-up', pid]);
            }
        }

        // Disconnect pipes before disposing their departed processes.
        for (const pid of this.livePipes) {
            if (!currentPipes.has(pid)) {
                events.push(['pipe-down', pid]);
            }
        }

        for (const pid of this.knownPids) {
            if (!knownPids.has(pid)) {
                events.push(['process-gone', pid]);
            }
        }

        this.knownPids = knownPids;
        this.livePipes = currentPipes;

        for (const [event, payload] of events) {
            if (this.stopped) {
                return;
            }

            this.emit(event, payload);
        }

        if (!this.stopped) {
            this.emit('tick');
        }
    }
}
