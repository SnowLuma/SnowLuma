import {
  createLogger,
  runWithTraceRequest,
  type Logger,
} from '@snowluma/common/logger';
import { renderParamsVerbose } from '@snowluma/common/log-summary';
import type { PacketSender } from '@snowluma/common/packet-sender';
import type { PacketInfo, PacketSink } from '@snowluma/common/protocol-types';
import {
  defaultHookUinFilter,
  type HookUinFilter,
  isHookUinFilterActive,
  isUinAllowedByFilter,
} from '@snowluma/common/runtime';
import { isRealUin } from '@snowluma/common/uin';
import fs from 'fs';
import { HookSession, type HookSessionDeps } from './hook-session';
import {
  injectHookProcess,
  listHookProcesses,
  resolveHookNativePath,
  unloadHookProcess,
  type HookProcessBaseInfo,
} from './injector';
import { PipeWatcher } from './pipe-watcher';
import { createNativeProcessEnumerator, type ProcessEnumerator } from './process-enumerator';
import { QqHookClient } from './qq-hook-client';
import { probeQqLoginInfo, type QqPortLoginInfo } from './qq-port-probe';
import type { HookProcessInfo } from './types';

const AUTO_LOAD_MAX_ATTEMPTS = 3;
const UIN_GATE_PROBE_INTERVAL_MS = 3000;
const UIN_GATE_DENIED_RECHECK_MS = 30_000;

type AutoLoadAttempt = {
  attempts: number;
  inFlight: boolean;
};

/**
 * Sink that the hook layer calls back into when it observes a new login,
 * a parsed packet, or a PID disconnect. The concrete implementation lives
 * in @snowluma/core (`BridgeManager`), which is wired in by the top-level
 * app entry. Declaring it here keeps @snowluma/bridge free of any
 * dependency on @snowluma/core — the hook package is self-contained.
 */
export interface BridgeManagerSink {
  onHookLogin(pid: number, uin: string, packetClient: PacketSender): void;
  onPacket(pkt: PacketInfo): void;
  onPidDisconnected(pid: number): void;
  onPidReceiveHealthChanged(pid: number, healthy: boolean): void;
}

export type HookManagerDeps = {
  bridgeManager: BridgeManagerSink;
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
   * Failed loads are logged and leave the session in the 'error' state.
   * A narrowly-classified early-process mapping race is retried on later
   * watcher ticks with a fixed attempt limit. */
  autoLoadOnDiscovery?: boolean;
  /** UIN allow/deny gate for auto-injection. When active, a newly-discovered
   * process is probed for its logged-in UIN before injection. */
  uinFilter?: HookUinFilter;
  /** Optional hook fired whenever the set of HookProcessInfo observable to
   * `listProcesses()` changes — new process discovered, process gone, or
   * any session's status mutated. Used by the WebUI SSE wiring to push a
   * fresh processes snapshot to connected clients without REST polling.
   * Exceptions thrown by the callback are caught and logged; they do not
   * break the watcher / session event loops. */
  onSessionsChanged?: () => void;
  log?: Logger;
};

/**
 * HookManager — thin orchestrator over a per-PID HookSession map and a
 * singleton PipeWatcher.
 *
 * Responsibilities:
 *   - Route user commands (load/unload/refresh) to the matching session.
 *   - Route watcher diff events to the matching session.
 *   - Forward session events ('login' / 'disconnected' / transport health) to BridgeManager.
 *   - Retry stuck-in-connecting sessions on every watcher tick (so a
 *     failed connect eventually recovers without a manual refresh).
 *   - Retry the bounded early-process auto-load race without retrying
 *     permanent injector errors.
 *
 * The native injector, native pipe-client, and native process/pipe
 * listings are all swappable dependencies so tests can run without a
 * real QQ.exe or a native addon.
 */
export class HookManager {
  private readonly bridgeManager: BridgeManagerSink;
  private readonly onPacket: PacketSink;
  private readonly injector: HookSessionDeps['injector'];
  private readonly makeClient: HookSessionDeps['makeClient'];
  private readonly pipeWatcher: PipeWatcher;
  private readonly ownsPipeWatcher: boolean;
  /** Watcher/API process enumeration — isolated + timeout-bounded by default
   *  so a blocked native /proc walk can't freeze the loop (issue #158).
   *  Resolves to `null` (UNKNOWN) on timeout/failure. */
  private readonly enumerate: () => Promise<HookProcessBaseInfo[] | null>;
  /** The owned enumerator (worker lifecycle), or null when a custom lister was
   *  injected (tests) — nothing to tear down in that case. */
  private readonly enumerator: ProcessEnumerator | null;
  private readonly autoLoadOnDiscovery: boolean;
  private uinFilter: HookUinFilter;
  private readonly uinGateState = new Map<number, { timer: ReturnType<typeof setTimeout> | null; startedAt: number; phase: 'probing' | 'denied'; lastCheckedUin: string }>();
  private readonly gateApprovedPids = new Set<number>();
  private readonly manualLoadPids = new Set<number>();
  private readonly onSessionsChangedRaw?: () => void;
  private readonly log: Logger;
  private readonly sessions = new Map<number, HookSession>();
  private readonly autoLoadAttempts = new Map<number, AutoLoadAttempt>();
  private readonly startPromise: Promise<void>;

  private disposed = false;

  constructor(deps: HookManagerDeps) {
    this.bridgeManager = deps.bridgeManager;
    this.onPacket = deps.onPacket ?? ((pkt) => deps.bridgeManager.onPacket(pkt));
    this.onSessionsChangedRaw = deps.onSessionsChanged;
    this.log = deps.log ?? createLogger('Hook');

    this.injector = deps.injector ?? {
      inject: injectHookProcess,
      unload: (pid, handle) => {
        if (!handle) return;
        unloadHookProcess(pid, handle);
      },
    };
    this.makeClient = deps.makeClient ?? ((pid: number) => new QqHookClient(pid));
    this.autoLoadOnDiscovery = deps.autoLoadOnDiscovery ?? false;
    this.uinFilter = deps.uinFilter ?? defaultHookUinFilter();

    // A custom lister (tests) is used directly — no worker, no isolation, just
    // an async wrap that maps a throw to the UNKNOWN sentinel. The default path
    // wraps the native enumerator in a worker with a timeout.
    if (deps.listProcesses) {
      const lister = deps.listProcesses;
      this.enumerator = null;
      this.enumerate = async () => {
        try {
          return await lister();
        } catch (error) {
          this.log.warn('listProcesses failed: %s', errMsg(error));
          return null;
        }
      };
    } else {
      this.enumerator = createNativeProcessEnumerator({
        addonPath: resolveHookNativePath('node'),
        fallbackSync: listHookProcesses,
        processName: defaultProcessName(),
        log: this.log,
      });
      this.enumerate = () => this.enumerator!.enumerate();
    }

    if (deps.pipeWatcher) {
      this.pipeWatcher = deps.pipeWatcher;
      this.ownsPipeWatcher = false;
    } else {
      this.pipeWatcher = new PipeWatcher({
        listProcesses: this.enumerate,
        listLivePipes: processes => QqHookClient.listLivePipes(processes.map(({ pid }) => pid)),
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
    const processes = await this.enumerate();
    if (processes === null) {
      // Enumeration timed out / failed — report the last-known sessions rather
      // than an empty list (which the WebUI would render as "no QQ").
      return [...this.sessions.values()]
        .map((s) => s.toInfo())
        .sort((a, b) => a.pid - b.pid);
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
    this.autoLoadAttempts.delete(pid);
    this.clearUinGate(pid);
    this.gateApprovedPids.delete(pid);
    this.manualLoadPids.add(pid);
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
    this.autoLoadAttempts.delete(pid);
    this.clearUinGate(pid);
    this.gateApprovedPids.delete(pid);
    this.manualLoadPids.delete(pid);
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

  setUinFilter(filter: HookUinFilter): void {
    const normalized = filter ?? defaultHookUinFilter();
    this.uinFilter = normalized;
    this.log.info(
      'hook uin-filter updated: mode=%s whitelist=%j blacklist=%j maxWaitMs=%d',
      normalized.mode,
      normalized.whitelist,
      normalized.blacklist,
      normalized.maxWaitMs,
    );
    if (!isHookUinFilterActive(normalized)) {
      for (const pid of [...this.uinGateState.keys()]) this.clearUinGate(pid);
      return;
    }
    if (!this.autoLoadOnDiscovery) return;
    for (const session of this.sessions.values()) {
      const pid = session.pid;
      const info = session.toInfo();
      if ((info.loggedIn || info.injected) && info.uin && !isUinAllowedByFilter(normalized, info.uin)) {
        this.log.warn(
          'hook uin-filter active: forcing uninjected for non-allowed session pid=%d uin=%s status=%s',
          pid,
          info.uin,
          info.status,
        );
        this.gateApprovedPids.delete(pid);
        this.clearUinGate(pid);
        try {
          this.bridgeManager.onPidDisconnected(pid);
        } catch { void 0; }
        this.forceSessionAvailable(pid);
        const state = { startedAt: Date.now(), timer: null, phase: 'denied' as const, lastCheckedUin: String(info.uin) };
        this.uinGateState.set(pid, state);
        this.scheduleUinGateProbe(pid, UIN_GATE_DENIED_RECHECK_MS);
      } else if (!info.injected && !this.uinGateState.has(pid) && shouldAutoLoadPid(pid, this.log)) {
        if (info.status === 'available' || info.status === 'error') {
          this.log.info('hook uin-filter active: gating existing available pid=%d', pid);
          this.startUinGate(session);
        }
      }
    }
  }

  private isPidBlocked(pid: number): boolean {
    const state = this.uinGateState.get(pid);
    return !!state && state.phase === 'denied' && isHookUinFilterActive(this.uinFilter);
  }

  private forceSessionAvailable(pid: number): void {
    const session = this.sessions.get(pid);
    if (!session) return;
    try {
      (session as unknown as { tearDownClient?: () => void }).tearDownClient?.();
    } catch { void 0; }
    (session as unknown as { injected: boolean }).injected = false;
    (session as unknown as { injectResult: unknown }).injectResult = null;
    (session as unknown as { _method: string })._method = '';
    (session as unknown as { _uin: string })._uin = '0';
    (session as unknown as { _error: string })._error = '';
    (session as unknown as { connected: boolean }).connected = false;
    (session as unknown as { loggedIn: boolean }).loggedIn = false;
    try {
      (session as unknown as { setStatus: (s: string, e: string) => void }).setStatus('available', '');
    } catch { void 0; }
    try {
      (this.pipeWatcher as unknown as { livePipes?: Set<number> }).livePipes?.delete(pid);
    } catch { void 0; }
    try {
      this.autoLoadAttempts.delete(pid);
    } catch { void 0; }
  }

  private clearUinGate(pid: number): void {
    const state = this.uinGateState.get(pid);
    if (state?.timer) clearTimeout(state.timer);
    this.uinGateState.delete(pid);
  }

  private startUinGate(session: HookSession): void {
    const pid = session.pid;
    if (this.uinGateState.has(pid)) return;
    this.log.info('hook uin-gate start: pid=%d mode=%s', pid, this.uinFilter.mode);
    const state = { startedAt: Date.now(), timer: null, phase: 'probing' as const, lastCheckedUin: '' };
    this.uinGateState.set(pid, state);
    this.scheduleUinGateProbe(pid, 0);
  }

  private scheduleUinGateProbe(pid: number, delayMs: number): void {
    const state = this.uinGateState.get(pid);
    if (!state || this.disposed) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.runUinGateProbe(pid), delayMs);
    if ((state.timer as unknown as { unref?: () => void }).unref) (state.timer as unknown as { unref: () => void }).unref();
  }

  private async runUinGateProbe(pid: number): Promise<void> {
    if (this.disposed) return;
    const state = this.uinGateState.get(pid);
    if (!state) return;
    const session = this.sessions.get(pid);
    if (!session || (session as unknown as { isDisposed: boolean }).isDisposed) {
      this.clearUinGate(pid);
      return;
    }
    if (!isHookUinFilterActive(this.uinFilter)) {
      this.clearUinGate(pid);
      this.runAutoLoad(session);
      return;
    }
    const maxWaitMs = this.uinFilter.maxWaitMs ?? 0;
    if (maxWaitMs > 0 && Date.now() - state.startedAt >= maxWaitMs) {
      if (state.phase === 'probing') {
        this.log.info('hook uin-gate timeout: pid=%d wait=%dms -> low-frequency monitor', pid, maxWaitMs);
        state.phase = 'denied';
      }
    }
    let info: QqPortLoginInfo | null = null;
    try {
      info = await this.probeProcessLoginInfo(pid);
    } catch (error) {
      this.log.warn('hook uin-gate probe failed: pid=%d err=%s', pid, error instanceof Error ? error.message : String(error));
    }
    if (this.disposed || !this.uinGateState.has(pid)) return;
    if (!this.sessions.has(pid)) {
      this.clearUinGate(pid);
      return;
    }
    if (info && info.identityKnown && isRealUin(info.uin)) {
      const uin = String(info.uin);
      state.lastCheckedUin = uin;
      const allowed = isUinAllowedByFilter(this.uinFilter, uin);
      if (allowed) {
        this.log.info('hook uin-gate allowed: pid=%d uin=%s mode=%s', pid, uin, this.uinFilter.mode);
        this.clearUinGate(pid);
        this.gateApprovedPids.add(pid);
        this.runAutoLoad(session);
        return;
      } else {
        if (state.phase !== 'denied') this.log.info('hook uin-gate denied: pid=%d uin=%s mode=%s -> low-frequency monitor', pid, uin, this.uinFilter.mode);
        state.phase = 'denied';
        const sessInfo = session.toInfo();
        if (sessInfo.loggedIn || sessInfo.injected) {
          this.log.warn('hook uin-gate denied but session already injected/online: pid=%d uin=%s status=%s -> forcing uninjected', pid, uin, sessInfo.status);
          try {
            this.bridgeManager.onPidDisconnected(pid);
          } catch { void 0; }
          this.forceSessionAvailable(pid);
        }
        this.scheduleUinGateProbe(pid, UIN_GATE_DENIED_RECHECK_MS);
        return;
      }
    }
    if (state.phase === 'denied') {
      this.scheduleUinGateProbe(pid, UIN_GATE_DENIED_RECHECK_MS);
    } else {
      this.scheduleUinGateProbe(pid, UIN_GATE_PROBE_INTERVAL_MS);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.uinGateState.values()) if (state.timer) clearTimeout(state.timer);
    this.uinGateState.clear();
    this.gateApprovedPids.clear();
    this.manualLoadPids.clear();
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.autoLoadAttempts.clear();
    this.enumerator?.dispose();
    if (this.ownsPipeWatcher) {
      this.pipeWatcher.dispose();
    }
  }

  // ─────────────── wiring ───────────────

  private bindWatcher(): void {
    this.pipeWatcher.on('process-discovered', (info: HookProcessBaseInfo) => {
      if (this.disposed) return;
      runWithTraceRequest(() => {
        const session = this.ensureSession(info.pid);
        session.attachProcessInfo(info);
        this.log.trace(() => [
          'hook_manager_fact event=process_discovered pid=%d info=%s autoLoad=%s',
          info.pid,
          renderParamsVerbose(info),
          this.autoLoadOnDiscovery,
        ]);
        if (this.autoLoadOnDiscovery && shouldAutoLoadPid(info.pid, this.log)) {
          if (!isHookUinFilterActive(this.uinFilter)) this.runAutoLoad(session);
          else this.startUinGate(session);
        }
        this.notifySessionsChanged();
      });
    });
    this.pipeWatcher.on('process-gone', (pid: number) => {
      if (this.disposed) return;
      runWithTraceRequest(() => {
        this.autoLoadAttempts.delete(pid);
        this.clearUinGate(pid);
        this.gateApprovedPids.delete(pid);
        this.manualLoadPids.delete(pid);
        const session = this.sessions.get(pid);
        this.log.trace(
          'hook_manager_fact event=process_gone pid=%d tracked=%s',
          pid,
          session !== undefined,
        );
        if (session) session.notifyProcessGone();
        this.notifySessionsChanged();
      });
    });
    this.pipeWatcher.on('pipe-up', (pid: number) => {
      if (this.disposed) return;
      if (this.isPidBlocked(pid)) {
        this.log.info('hook uin-filter: pipe-up blocked for denied pid=%d', pid);
        return;
      }
      const session = this.sessions.get(pid);
      if (session) session.onPipeUp();
    });
    this.pipeWatcher.on('pipe-down', (pid: number) => {
      if (this.disposed) return;
      const session = this.sessions.get(pid);
      if (session) session.onPipeDown();
    });
    // After every tick, retry sessions that are stuck in 'connecting' OR
    // 'disconnected' while the pipe is up. Mirrors the original
    // tickWatcher's per-tick reconcileConnect pass; onPipeUp is idempotent
    // so calling it for an already-connected session is harmless.
    //
    // The 'disconnected' branch matters on Windows: when the QQ-NT side of
    // the named pipe stays alive but the SnowLuma-side socket dies (read
    // EPIPE / idle-timeout / similar transient I/O fault), the watcher
    // sees the pipe as still-live (the OS-level pipe is still listed by
    // `listLivePipes`) so it never fires another `pipe-up`. Without
    // retrying 'disconnected' sessions here the session is stranded
    // forever — a real-world symptom users reported as "Windows running
    // for a while then stops" with logs `pipe error: read EPIPE` →
    // `session closed: UIN=…`.
    this.pipeWatcher.on('tick', () => {
      if (this.disposed) return;
      for (const session of this.sessions.values()) {
        const autoLoad = this.autoLoadAttempts.get(session.pid);
        if (autoLoad && !autoLoad.inFlight && session.status === 'error'
          && isTransientLibcMappingError(session.error)) {
          this.runAutoLoad(session, autoLoad);
          continue;
        }
        if ((session.status === 'connecting' || session.status === 'disconnected')
          && this.pipeWatcher.isPipeLive(session.pid)) {
          if (this.isPidBlocked(session.pid)) continue;
          session.onPipeUp();
        }
      }
    });
  }

  private runAutoLoad(session: HookSession, existing?: AutoLoadAttempt): void {
    if (this.disposed || session.isDisposed) return;
    const state = existing ?? { attempts: 0, inFlight: false };
    if (state.inFlight || state.attempts >= AUTO_LOAD_MAX_ATTEMPTS) return;

    state.attempts += 1;
    state.inFlight = true;
    this.autoLoadAttempts.set(session.pid, state);
    const attempt = state.attempts;

    void runWithTraceRequest(async () => {
      const startedAt = Date.now();
      this.log.trace(
        'hook_autoload_start pid=%d attempt=%d maxAttempts=%d',
        session.pid,
        attempt,
        AUTO_LOAD_MAX_ATTEMPTS,
      );
      try {
        const info = await session.load();
        if (this.autoLoadAttempts.get(session.pid) !== state) {
          this.log.trace(
            'hook_autoload_terminal pid=%d attempt=%d outcome=dropped reason=superseded elapsedMs=%d',
            session.pid,
            attempt,
            Date.now() - startedAt,
          );
          return;
        }
        state.inFlight = false;

        if (info.status !== 'error') {
          this.autoLoadAttempts.delete(session.pid);
          const reason = attempt > 1 ? 'recovered' : 'loaded';
          this.log.trace(() => [
            'hook_autoload_terminal pid=%d attempt=%d outcome=completed reason=%s state=%s elapsedMs=%d',
            session.pid,
            attempt,
            reason,
            renderParamsVerbose(info),
            Date.now() - startedAt,
          ]);
          if (attempt > 1) {
            this.log.info(
              'auto-load recovered: PID=%d attempt=%d/%d',
              session.pid,
              attempt,
              AUTO_LOAD_MAX_ATTEMPTS,
            );
          }
          return;
        }

        if (!isTransientLibcMappingError(info.error)) {
          this.autoLoadAttempts.delete(session.pid);
          this.log.trace(
            'hook_autoload_terminal pid=%d attempt=%d outcome=failed reason=permanent_failure error=%j elapsedMs=%d',
            session.pid,
            attempt,
            info.error,
            Date.now() - startedAt,
          );
          return;
        }

        if (attempt >= AUTO_LOAD_MAX_ATTEMPTS) {
          this.autoLoadAttempts.delete(session.pid);
          this.log.trace(
            'hook_autoload_terminal pid=%d attempt=%d outcome=failed reason=retry_exhausted error=%j elapsedMs=%d',
            session.pid,
            attempt,
            info.error,
            Date.now() - startedAt,
          );
          this.log.warn(
            'auto-load retry exhausted: PID=%d attempts=%d err=%s',
            session.pid,
            attempt,
            info.error,
          );
          return;
        }

        this.log.trace(
          'hook_autoload_terminal pid=%d attempt=%d outcome=failed reason=retry_pending error=%j elapsedMs=%d',
          session.pid,
          attempt,
          info.error,
          Date.now() - startedAt,
        );
        this.log.warn(
          'auto-load retry pending: PID=%d attempt=%d/%d err=%s',
          session.pid,
          attempt,
          AUTO_LOAD_MAX_ATTEMPTS,
          info.error,
        );
      } catch (err) {
        if (this.autoLoadAttempts.get(session.pid) === state) {
          this.autoLoadAttempts.delete(session.pid);
        }
        this.log.trace(
          'hook_autoload_terminal pid=%d attempt=%d outcome=failed reason=unexpected_failure error=%j elapsedMs=%d',
          session.pid,
          attempt,
          errMsg(err),
          Date.now() - startedAt,
        );
        this.log.warn('auto-load failed: PID=%d err=%s', session.pid, errMsg(err));
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
      this.log.info(
        'hook login attempt: pid=%d uin=%s mode=%s whitelist=%j blacklist=%j active=%s allowed=%s manual=%s',
        pid,
        String(uin),
        this.uinFilter.mode,
        this.uinFilter.whitelist,
        this.uinFilter.blacklist,
        isHookUinFilterActive(this.uinFilter),
        isUinAllowedByFilter(this.uinFilter, uin),
        this.manualLoadPids.has(pid),
      );
      if (isHookUinFilterActive(this.uinFilter) && !isUinAllowedByFilter(this.uinFilter, uin)) {
        if (this.manualLoadPids.has(pid)) {
          this.log.info('hook uin-filter: manual load bypass allowed pid=%d uin=%s mode=%s', pid, String(uin), this.uinFilter.mode);
          this.manualLoadPids.delete(pid);
          this.gateApprovedPids.delete(pid);
          this.clearUinGate(pid);
          this.bridgeManager.onHookLogin(pid, uin, sender);
          return;
        }
        this.log.warn('hook uin-gate post-login denied: pid=%d uin=%s mode=%s -> blocking injection', pid, String(uin), this.uinFilter.mode);
        this.gateApprovedPids.delete(pid);
        this.clearUinGate(pid);
        try {
          this.bridgeManager.onPidDisconnected(pid);
        } catch { void 0; }
        this.forceSessionAvailable(pid);
        const state = { startedAt: Date.now(), timer: null, phase: 'denied' as const, lastCheckedUin: String(uin) };
        this.uinGateState.set(pid, state);
        this.scheduleUinGateProbe(pid, UIN_GATE_DENIED_RECHECK_MS);
        return;
      }
      if (this.gateApprovedPids.has(pid)) this.gateApprovedPids.delete(pid);
      this.manualLoadPids.delete(pid);
      this.clearUinGate(pid);
      this.bridgeManager.onHookLogin(pid, uin, sender);
    });
    session.on('disconnected', (wasLoggedIn: boolean) => {
      if (wasLoggedIn) this.bridgeManager.onPidDisconnected(pid);
    });
    session.on('receive-health-changed', (healthy: boolean) => {
      this.bridgeManager.onPidReceiveHealthChanged(pid, healthy);
    });
    // status-changed fires on EVERY internal status mutation, including the
    // ones reached via login / disconnected / refresh — subscribing here
    // alone covers every transition the WebUI processes view cares about.
    session.on('status-changed', () => {
      this.notifySessionsChanged();
    });
    session.on('disposed', () => {
      this.sessions.delete(pid);
    });

    this.sessions.set(pid, session);
    return session;
  }

  /** Fire the optional sessions-changed hook with exceptions isolated.
   * A throwing subscriber must not abort the watcher's emit loop or break
   * a HookSession event handler in flight. */
  private notifySessionsChanged(): void {
    if (this.disposed) return;
    if (!this.onSessionsChangedRaw) return;
    try {
      this.onSessionsChangedRaw();
    } catch (err) {
      this.log.warn('onSessionsChanged threw: %s', errMsg(err));
    }
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

function isTransientLibcMappingError(error: string): boolean {
  return /^target process does not map \S*\/libc\.so\.6 while resolving mmap$/.test(error);
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
export type { HookProcessBaseInfo } from './injector';
export type { QqPortLoginInfo } from './qq-port-probe';
export type { HookProcessInfo, HookProcessStatus } from './types';
