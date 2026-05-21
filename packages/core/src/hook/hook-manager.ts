import fs from 'fs';
import type { BridgeManager } from '../bridge/manager';
import type { PacketSink } from '@snowluma/common/protocol-types';
import { createLogger, type Logger } from '@snowluma/common/logger';
import {
  injectHookProcess,
  listHookProcesses,
  unloadHookProcess,
  type HookProcessBaseInfo,
} from './injector';
import { HookSession, type HookSessionDeps } from './hook-session';
import { PipeWatcher } from './pipe-watcher';
import { QqHookClient } from './qq-hook-client';
import type { HookProcessInfo } from './types';
import { probeQqLoginInfo, type QqPortLoginInfo } from './qq-port-probe';

export type { HookProcessInfo, HookProcessStatus } from './types';
export type { HookProcessBaseInfo } from './injector';
export type { QqPortLoginInfo } from './qq-port-probe';

export type HookManagerDeps = {
  bridgeManager: BridgeManager;
  /** Sink for parsed packets from any live HookSession. Defaults to
   * `bridgeManager.onPacket` — every packet flows straight into the
   * per-UIN bridge dispatcher with no intermediate event emitter. */
  onPacket?: PacketSink;
  /** Native injector entrypoints. Defaults to the real native addon. */
  injector?: HookSessionDeps['injector'];
  /** Hook pipe-client factory. Defaults to `new QqHookClient(pid)`. */
  makeClient?: HookSessionDeps['makeClient'];
  /** Pre-built watcher. Defaults to a PipeWatcher wrapping the native listings. */
  pipeWatcher?: PipeWatcher;
  /** Polling interval for the default watcher. Ignored if `pipeWatcher` is provided. */
  watcherIntervalMs?: number;
  /** Native process lister used by `listProcesses()`. Defaults to the native addon. */
  listProcesses?: () => HookProcessBaseInfo[];
  /** When true, every newly-discovered QQ process is auto-injected (fires
   * `loadProcess(pid)` from the watcher's 'process-discovered' handler).
   * Failed loads are logged and leave the session in the 'error' state. */
  autoLoadOnDiscovery?: boolean;
  log?: Logger;
};

/**
 * HookManager — thin orchestrator over a per-PID HookSession map and a
 * singleton PipeWatcher.
 *
 * Responsibilities:
 *   - Route user commands (load/unload/refresh) to the matching session.
 *   - Route watcher diff events to the matching session.
 *   - Forward session events ('login' / 'disconnected') to BridgeManager.
 *   - Retry stuck-in-connecting sessions on every watcher tick (so a
 *     failed connect eventually recovers without a manual refresh).
 *
 * The native injector, native pipe-client, and native process/pipe
 * listings are all swappable dependencies so tests can run without a
 * real QQ.exe or a native addon.
 */
export class HookManager {
  private readonly bridgeManager: BridgeManager;
  private readonly onPacket: PacketSink;
  private readonly injector: HookSessionDeps['injector'];
  private readonly makeClient: HookSessionDeps['makeClient'];
  private readonly pipeWatcher: PipeWatcher;
  private readonly ownsPipeWatcher: boolean;
  private readonly listProcessesNative: () => HookProcessBaseInfo[];
  private readonly autoLoadOnDiscovery: boolean;
  private readonly log: Logger;
  private readonly sessions = new Map<number, HookSession>();
  private readonly startPromise: Promise<void>;

  private disposed = false;

  constructor(deps: HookManagerDeps) {
    this.bridgeManager = deps.bridgeManager;
    this.onPacket = deps.onPacket ?? ((pkt) => deps.bridgeManager.onPacket(pkt));
    this.log = deps.log ?? createLogger('Hook');

    this.injector = deps.injector ?? {
      inject: injectHookProcess,
      unload: (pid, handle) => {
        if (!handle) return;
        unloadHookProcess(pid, handle);
      },
    };
    this.makeClient = deps.makeClient ?? ((pid: number) => new QqHookClient(pid));
    this.listProcessesNative = deps.listProcesses ?? listHookProcesses;
    this.autoLoadOnDiscovery = deps.autoLoadOnDiscovery ?? false;

    if (deps.pipeWatcher) {
      this.pipeWatcher = deps.pipeWatcher;
      this.ownsPipeWatcher = false;
    } else {
      this.pipeWatcher = new PipeWatcher({
        listProcesses: this.listProcessesNative,
        listLivePipes: () => QqHookClient.listLivePipes(),
        intervalMs: deps.watcherIntervalMs,
        log: this.log,
      });
      this.ownsPipeWatcher = true;
    }

    this.bindWatcher();
    this.startPromise = this.pipeWatcher.start();
  }

  // ─────────────── public API (unchanged from prior HookManager) ───────────────

  async listProcesses(): Promise<HookProcessInfo[]> {
    await this.startPromise;
    let processes: HookProcessBaseInfo[];
    try {
      processes = this.listProcessesNative();
    } catch (error) {
      this.log.warn('listProcesses failed: %s', errMsg(error));
      processes = [];
    }
    const result: HookProcessInfo[] = [];
    for (const proc of processes) {
      const session = this.ensureSession(proc.pid);
      session.attachProcessInfo(proc);
      result.push(session.toInfo());
    }
    return result.sort((a, b) => a.pid - b.pid);
  }

  async loadProcess(pid: number): Promise<HookProcessInfo> {
    this.assertValidPid(pid);
    await this.startPromise;
    const session = this.ensureSession(pid);
    const info = await session.load();
    // Pull the next tick forward so a freshly-injected pipe gets noticed
    // within the next event-loop turn instead of after the full interval.
    this.pipeWatcher.wake();
    return info;
  }

  async unloadProcess(pid: number): Promise<HookProcessInfo> {
    this.assertValidPid(pid);
    await this.startPromise;
    const session = this.ensureSession(pid);
    return session.unload();
  }

  async refreshProcess(pid: number): Promise<HookProcessInfo> {
    this.assertValidPid(pid);
    await this.startPromise;
    const session = this.ensureSession(pid);
    return session.refresh();
  }

  async probeProcessLoginInfo(pid: number): Promise<QqPortLoginInfo | null> {
    this.assertValidPid(pid);
    return probeQqLoginInfo(pid);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    if (this.ownsPipeWatcher) {
      this.pipeWatcher.dispose();
    }
  }

  // ─────────────── wiring ───────────────

  private bindWatcher(): void {
    this.pipeWatcher.on('process-discovered', (info: HookProcessBaseInfo) => {
      if (this.disposed) return;
      const session = this.ensureSession(info.pid);
      session.attachProcessInfo(info);
      // Headless/Docker deployments enable autoLoadOnDiscovery so QQ gets
      // injected without a human clicking "Load" in WebUI. Fire-and-forget:
      // failures are already captured inside loadInternal and surfaced via
      // the session's status field.
      if (this.autoLoadOnDiscovery && shouldAutoLoadPid(info.pid, this.log)) {
        void session.load().catch((err) => {
          this.log.warn('auto-load failed: PID=%d err=%s', info.pid, errMsg(err));
        });
      }
    });
    this.pipeWatcher.on('process-gone', (pid: number) => {
      if (this.disposed) return;
      const session = this.sessions.get(pid);
      if (session) session.notifyProcessGone();
    });
    this.pipeWatcher.on('pipe-up', (pid: number) => {
      if (this.disposed) return;
      const session = this.sessions.get(pid);
      if (session) session.onPipeUp();
    });
    this.pipeWatcher.on('pipe-down', (pid: number) => {
      if (this.disposed) return;
      const session = this.sessions.get(pid);
      if (session) session.onPipeDown();
    });
    // After every tick, retry sessions that are stuck in 'connecting'
    // while the pipe is up. Mirrors the original tickWatcher's per-tick
    // reconcileConnect pass; onPipeUp is idempotent so calling it for an
    // already-connected session is harmless.
    this.pipeWatcher.on('tick', () => {
      if (this.disposed) return;
      for (const session of this.sessions.values()) {
        if (session.status === 'connecting' && this.pipeWatcher.isPipeLive(session.pid)) {
          session.onPipeUp();
        }
      }
    });
  }

  private ensureSession(pid: number): HookSession {
    let session = this.sessions.get(pid);
    if (session) return session;

    session = new HookSession(pid, {
      injector: this.injector,
      makeClient: this.makeClient,
      pipeWatcher: this.pipeWatcher,
      onPacket: this.onPacket,
      log: this.log,
    });
    session.attachProcessInfo({ name: defaultProcessName() });

    session.on('login', (uin: string, sender) => {
      this.bridgeManager.onHookLogin(pid, uin, sender);
    });
    session.on('disconnected', (wasLoggedIn: boolean) => {
      if (wasLoggedIn) this.bridgeManager.onPidDisconnected(pid);
    });
    session.on('disposed', () => {
      this.sessions.delete(pid);
    });

    this.sessions.set(pid, session);
    return session;
  }

  private assertValidPid(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid pid');
  }
}

function defaultProcessName(): string {
  return process.platform === 'win32' ? 'QQ.exe' : 'qq';
}

function errMsg(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Filter for auto-load only. Returns false for Linux Electron child
 * processes (zygote/renderer/gpu/utility), which the native enumerator
 * mis-classifies as "main QQ" because their cmdline contains "qq" and
 * they transiently inherit wrapper.node via fork copy-on-write.
 *
 * Injecting into a zygote spawns the hook's resolver thread inside it;
 * every renderer Electron later forks then inherits that thread + the
 * partially-init'd hook state, which breaks QQ's IPC and login UI.
 *
 * Manual loadProcess() bypasses this gate — the operator is responsible
 * for picking the right PID from WebUI.
 */
export function shouldAutoLoadPid(pid: number, log: Logger): boolean {
  if (process.platform !== 'linux') return true;
  // Escape hatch: operators who explicitly want auto-load on every
  // enumerated PID can set this to opt out of the filter.
  if (process.env.SNOWLUMA_HOOK_AUTOLOAD_ALL === '1') return true;

  let cmdline: string;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    // Can't read cmdline (process gone, permission, etc.) — let the
    // existing load() path handle it; if the process is dead the load
    // will fail with a clear error.
    return true;
  }
  if (cmdline.includes('--type=')) {
    const type = (/--type=([^\0\s]+)/.exec(cmdline)?.[1]) ?? 'unknown';
    log.info('auto-load skip: PID=%d is an Electron child process (--type=%s)', pid, type);
    return false;
  }
  return true;
}
