import { createLogger, type Logger } from '@snowluma/common/logger';
import { EventEmitter } from 'events';
import type { HookProcessBaseInfo } from './injector';

const DEFAULT_INTERVAL_MS = 1500;
const MIN_INTERVAL_MS = 250;

export type PipeWatcherDeps = {
  /** Native: list QQ.exe processes currently running. */
  listProcesses: () => HookProcessBaseInfo[];
  /** Native: PIDs that currently have a live SnowLuma named pipe. */
  listLivePipes: () => Promise<Set<number>>;
  /** Polling interval in ms. Defaults to 1500, floored to 250. */
  intervalMs?: number;
  log?: Logger;
};

/**
 * PipeWatcher — the only module that polls the OS for QQ.exe processes
 * and live SnowLuma named pipes. Subscribers consume diffs as events.
 *
 * Lifecycle: start() runs one tick synchronously, then schedules a poll
 * every `intervalMs`. tickNow() drains a single tick on demand. wake()
 * pulls the next scheduled tick forward to the next event-loop turn.
 *
 * Emitted events:
 *   'process-discovered' (info: HookProcessBaseInfo) — a QQ.exe appeared
 *   'process-gone'       (pid: number)               — a QQ.exe disappeared
 *   'pipe-up'            (pid: number)               — named pipe came up
 *   'pipe-down'          (pid: number)               — named pipe dropped
 *   'tick'               ()                          — fired after every poll
 *
 * Within a single tick the order is: process-discovered, pipe-up,
 * pipe-down, process-gone, tick. That ordering lets HookManager create
 * a session before it gets a pipe event and run disconnect logic before
 * dispose logic when QQ.exe is killed with a live pipe.
 */
export class PipeWatcher extends EventEmitter {
  private readonly listProcesses: PipeWatcherDeps['listProcesses'];
  private readonly listLivePipes: PipeWatcherDeps['listLivePipes'];
  private readonly intervalMs: number;
  private readonly log: Logger;

  private livePipes = new Set<number>();
  private knownPids = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private pendingWake = false;
  private startPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(deps: PipeWatcherDeps) {
    super();
    this.listProcesses = deps.listProcesses;
    this.listLivePipes = deps.listLivePipes;
    this.intervalMs = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.log = deps.log ?? createLogger('PipeWatcher');
  }

  /** Was this PID's pipe live as of the last completed tick? */
  isPipeLive(pid: number): boolean {
    return this.livePipes.has(pid);
  }

  /** Was this PID alive as of the last completed tick? */
  isProcessAlive(pid: number): boolean {
    return this.knownPids.has(pid);
  }

  /**
   * Run an initial tick (so isPipeLive/isProcessAlive return real data)
   * and begin the polling loop. Idempotent.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        await this.tickOnce();
      } finally {
        this.scheduleNext(this.intervalMs);
      }
    })();
    return this.startPromise;
  }

  /** Pull the next scheduled tick forward to the next event-loop turn. */
  wake(): void {
    if (this.stopped) return;
    this.scheduleNext(0);
  }

  /** Force a single tick now. Resolves after diff events have been emitted. */
  tickNow(): Promise<void> {
    return this.tickOnce();
  }

  stop(): void {
    this.stopped = true;
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
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tickAndReschedule();
    }, Math.max(0, delayMs));
  }

  private async tickAndReschedule(): Promise<void> {
    try {
      await this.tickOnce();
    } finally {
      this.scheduleNext(this.intervalMs);
    }
  }

  /**
   * Read processes + live pipes, emit diff events. If another tick is
   * already running, mark a follow-up tick so we don't lose a wake().
   */
  private async tickOnce(): Promise<void> {
    if (this.ticking) {
      this.pendingWake = true;
      return;
    }
    this.ticking = true;
    try {
      let processes: HookProcessBaseInfo[];
      try {
        processes = this.listProcesses();
      } catch (error) {
        this.log.warn('listProcesses failed: %s', errMsg(error));
        processes = [];
      }
      let livePipes: Set<number>;
      try {
        livePipes = await this.listLivePipes();
      } catch (error) {
        this.log.warn('listLivePipes failed: %s', errMsg(error));
        livePipes = new Set();
      }

      const newKnownPids = new Set<number>();
      for (const proc of processes) newKnownPids.add(proc.pid);

      // 1. Newly discovered processes.
      for (const proc of processes) {
        if (!this.knownPids.has(proc.pid)) {
          this.emit('process-discovered', proc);
        }
      }

      // 2. Pipes that came up. Ignore pipes for processes we don't know
      //    about (would race against an out-of-order tick).
      const newLivePipes = new Set<number>();
      for (const pid of livePipes) {
        if (!newKnownPids.has(pid)) continue;
        newLivePipes.add(pid);
        if (!this.livePipes.has(pid)) {
          this.emit('pipe-up', pid);
        }
      }

      // 3. Pipes that dropped. Emit pipe-down BEFORE process-gone so
      //    subscribers can run disconnect logic before dispose logic.
      for (const pid of this.livePipes) {
        if (!newLivePipes.has(pid)) {
          this.emit('pipe-down', pid);
        }
      }

      // 4. Processes that disappeared.
      for (const pid of this.knownPids) {
        if (!newKnownPids.has(pid)) {
          this.emit('process-gone', pid);
        }
      }

      this.knownPids = newKnownPids;
      this.livePipes = newLivePipes;
      this.emit('tick');
    } finally {
      this.ticking = false;
      if (this.pendingWake) {
        this.pendingWake = false;
        // Defer to break sync recursion if a listener calls wake().
        setImmediate(() => { void this.tickOnce(); });
      }
    }
  }
}

function errMsg(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
