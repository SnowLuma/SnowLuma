import {
  createLogger,
  runWithoutRequestContext,
  runWithTraceRequest,
  type Logger,
} from '@snowluma/common/logger';
import { renderParamsVerbose } from '@snowluma/common/log-summary';
import type { PacketSink } from '@snowluma/common/protocol-types';
import { isRealUin } from '@snowluma/common/uin';
import { EventEmitter } from 'events';
import { HookPacketClient } from './hook-packet-client';
import type { HookInjectResult } from './injector';
import type { QqHookClient, QqHookLoginState, QqHookPacket } from './qq-hook-client';
import { probeQqLoginInfo, type QqPortLoginInfo } from './qq-port-probe';
import { statusFor } from './hook-status';
import type { HookProcessInfo, HookProcessStatus } from './types';

/** How often to re-check account identity while the connection is not ready.
 *  Identity alone never proves that requests can be served. */
const LOGIN_RECONCILE_INTERVAL_MS = 3000;
const LOGIN_IDENTITY_OBSERVE_INTERVAL_MS = 30_000;
const LOGIN_HINT_MAX_ATTEMPTS = 3;
const LOGIN_HINT_RETRY_DELAYS_MS = [3000, 9000] as const;

/** QQ emits this response periodically while its MSF receive path is healthy.
 *  Seeing it once arms the watchdog; before that, silence is UNKNOWN rather
 *  than unhealthy so QQ versions that do not expose this command cannot be
 *  false-flagged. Any later recv packet proves the same end-to-end path. */
const QQ_RECV_HEARTBEAT_CMD = 'trpc.qq_new_tech.status_svc.StatusService.SsoHeartBeat';
const RECEIVE_STALE_AFTER_MS = 90_000;
const RECEIVE_STALE_CONFIRM_MS = 15_000;

export type HookSessionDeps = {
  injector: {
    inject: (pid: number) => HookInjectResult | Promise<HookInjectResult>;
    unload: (pid: number, handle: HookInjectResult['handle']) => void;
  };
  makeClient: (pid: number) => QqHookClient;
  /** Active, pipe-independent login probe (reads QQ's ptlogin/deeplink ports).
   *  Drives the login-reconcile safety net; injectable for tests. Defaults to
   *  `probeQqLoginInfo`. */
  probeLogin?: (pid: number) => Promise<QqPortLoginInfo | null>;
  /** Sync fast-path check used by load() to skip re-injection when a
   * prior SnowLuma run left a working pipe behind. `tickNow` forces a
   * fresh poll — used after unload to dodge the up-to-1500ms cache
   * staleness that would otherwise false-flag a successful unload. */
  pipeWatcher: {
    isPipeLive: (pid: number) => boolean;
    tickNow?: () => Promise<void>;
  };
  /** Sink for parsed packets. Called with the BridgeManager-shaped
   * PacketInfo for every packet received while logged in. If omitted,
   * packets are dropped (useful in unit tests that don't care). */
  onPacket?: PacketSink;
  log?: Logger;
};

/**
 * HookSession — owns the lifecycle of one QQ.exe process: injection,
 * pipe client, login state, and the public status field.
 *
 * Concurrency: every state-mutating method goes through a per-session
 * promise chain so user clicks (load/unload/refresh) and watcher-driven
 * events (onPipeUp/onPipeDown) never interleave.
 *
 * Communication: emits high-level events instead of calling BridgeManager
 * directly, so HookManager forwards them and tests can attach spies.
 *
 * Emitted events:
 *   'login'          (uin, packetSender) — real-UIN login detected
 *   'disconnected'   (wasLoggedIn)       — connection dropped or torn down
 *   'receive-health-changed' (healthy)   — receive path confirmed stale/recovered
 *   'status-changed' (status, error)     — status field mutated
 *   'disposed'       ()                  — session stopped tracking this PID
 */
export class HookSession extends EventEmitter {
  readonly pid: number;

  private readonly injector: HookSessionDeps['injector'];
  private readonly makeClient: HookSessionDeps['makeClient'];
  private readonly probeLogin: (pid: number) => Promise<QqPortLoginInfo | null>;
  private readonly pipeWatcher: HookSessionDeps['pipeWatcher'];
  private readonly onPacket: PacketSink | null;
  private readonly log: Logger;

  private _status: HookProcessStatus = 'available';
  private _error = '';
  private _uin = '0';
  private _method = '';
  private _name = '';
  private _path = '';

  private injected = false;
  private connected = false;
  private loggedIn = false;
  private injectResult: HookInjectResult | null = null;
  private client: QqHookClient | null = null;
  private sender: HookPacketClient | null = null;
  private bound = false;
  private opChain: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private loginProbeTimer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  private acceptedLoginHintUin = '';
  private loginHintAttemptUin = '';
  private loginHintAttempts = 0;
  private nextLoginHintAt = 0;
  private nextLoginIdentityObservationAt = 0;
  private _receiveHealthy = true;
  private receiveWatchUin = '';
  private receiveWatchArmed = false;
  private receiveWatchTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReceiveAt = 0;

  constructor(pid: number, deps: HookSessionDeps) {
    super();
    this.pid = pid;
    this.injector = deps.injector;
    this.makeClient = deps.makeClient;
    this.probeLogin = deps.probeLogin ?? probeQqLoginInfo;
    this.pipeWatcher = deps.pipeWatcher;
    this.onPacket = deps.onPacket ?? null;
    this.log = deps.log ?? createLogger('HookSession');
  }

  // ─────────────── readonly public surface ───────────────

  get status(): HookProcessStatus { return this._status; }
  get error(): string { return this._error; }
  get uin(): string { return this._uin; }
  get method(): string { return this._method; }
  get isDisposed(): boolean { return this.disposed; }
  get receiveHealthy(): boolean { return this._receiveHealthy; }

  attachProcessInfo(info: { name?: string; path?: string }): void {
    if (info.name) this._name = info.name;
    if (info.path) this._path = info.path;
  }

  toInfo(): HookProcessInfo {
    return {
      pid: this.pid,
      name: this._name,
      path: this._path,
      injected: this.injected,
      connected: this.connected,
      loggedIn: this.loggedIn,
      uin: this._uin,
      status: this._status,
      error: this._error,
      method: this._method,
    };
  }

  // ─────────────── user-facing commands ───────────────

  load(): Promise<HookProcessInfo> {
    return this.traceCommand('load', () => this.loadInternal());
  }

  unload(): Promise<HookProcessInfo> {
    return this.traceCommand('unload', () => this.unloadInternal());
  }

  refresh(): Promise<HookProcessInfo> {
    return this.traceCommand('refresh', () => this.refreshInternal());
  }

  // ─────────────── watcher-driven events (called by manager) ───────────────

  /** Pipe came up (or stayed up across a SnowLuma restart). Drives connect
   * attempts and adopts pre-existing hooks. Idempotent; safe to call on
   * every watcher tick where the pipe is live. */
  onPipeUp(): void {
    if (this.disposed) return;
    void this.serialize(async () => {
      if (this.disposed) return;
      await this.reconcilePipeUp();
    }).catch(err => this.log.warn('onPipeUp failed: PID=%d err=%s', this.pid, errMsg(err)));
  }

  onPipeDown(): void {
    if (this.disposed) return;
    void this.serialize(async () => {
      if (this.disposed) return;
      this.reconcilePipeDown();
    }).catch(err => this.log.warn('onPipeDown failed: PID=%d err=%s', this.pid, errMsg(err)));
  }

  /** Called by the manager when the watcher reports the QQ.exe process is
   * gone. Cleans up and signals the manager to remove this session. */
  notifyProcessGone(): void {
    if (this.disposed) return;
    void this.serialize(async () => {
      if (this.disposed) return;
      runWithTraceRequest(() => {
        const startedAt = Date.now();
        const wasLoggedIn = this.loggedIn;
        this.log.trace(() => [
          'hook_session_process_start pid=%d event=process_gone state=%s',
          this.pid,
          renderParamsVerbose(this.toInfo()),
        ]);
        this.tearDownClient();
        this.injected = false;
        this.injectResult = null;
        this._method = '';
        this.setStatus('available', '');
        try {
          if (wasLoggedIn) this.emit('disconnected', true);
          this.disposed = true;
          this.emit('disposed');
          this.log.trace(() => [
            'hook_session_process_terminal pid=%d outcome=completed reason=process_gone wasLoggedIn=%s state=%s elapsedMs=%d',
            this.pid,
            wasLoggedIn,
            renderParamsVerbose(this.toInfo()),
            Date.now() - startedAt,
          ]);
          this.removeAllListeners();
        } catch (error) {
          this.log.trace(() => [
            'hook_session_process_terminal pid=%d outcome=failed reason=listener_failed error=%j state=%s elapsedMs=%d',
            this.pid,
            errMsg(error),
            renderParamsVerbose(this.toInfo()),
            Date.now() - startedAt,
          ]);
          throw error;
        }
      });
    }).catch(err => this.log.warn('notifyProcessGone failed: PID=%d err=%s', this.pid, errMsg(err)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tearDownClient();
    this.removeAllListeners();
  }

  // ─────────────── per-session serialization ───────────────

  private traceCommand(
    operation: 'load' | 'unload' | 'refresh',
    command: () => Promise<HookProcessInfo>,
  ): Promise<HookProcessInfo> {
    return runWithTraceRequest(async () => {
      const startedAt = Date.now();
      this.log.trace(() => [
        'hook_session_start pid=%d operation=%s state=%s',
        this.pid,
        operation,
        renderParamsVerbose(this.toInfo()),
      ]);
      try {
        const info = await this.serialize(command);
        const outcome = info.status === 'error'
          || (operation === 'unload' && info.status !== 'available')
          ? 'failed'
          : 'completed';
        let reason: string;
        if (operation === 'unload' && info.status === 'connecting') {
          reason = 'unload_verification_failed';
        } else if (outcome === 'failed') {
          reason = `${operation}_failed`;
        } else {
          reason = `${operation}_settled`;
        }
        this.log.trace(() => [
          'hook_session_terminal pid=%d operation=%s outcome=%s reason=%s%s state=%s elapsedMs=%d',
          this.pid,
          operation,
          outcome,
          reason,
          info.error ? ` error=${JSON.stringify(info.error)}` : '',
          renderParamsVerbose(info),
          Date.now() - startedAt,
        ]);
        return info;
      } catch (error) {
        this.log.trace(() => [
          'hook_session_terminal pid=%d operation=%s outcome=failed reason=%s error=%j state=%s elapsedMs=%d',
          this.pid,
          operation,
          `${operation}_threw`,
          errMsg(error),
          renderParamsVerbose(this.toInfo()),
          Date.now() - startedAt,
        ]);
        throw error;
      }
    });
  }

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const previous = this.opChain;
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    this.opChain = previous.then(() => completion);
    return (async () => {
      try {
        await previous.catch(() => undefined);
        return await op();
      } finally {
        release();
      }
    })();
  }

  // ─────────────── internal transitions ───────────────

  private async loadInternal(): Promise<HookProcessInfo> {
    this._error = '';
    this.setStatus('loading', '');
    try {
      if (!this.injected) {
        // Fast path: a previous SnowLuma run may have left the hook DLL
        // resident in QQ.exe. If the watcher already sees a live pipe,
        // skip re-injection and let onPipeUp drive the reconnect.
        if (this.pipeWatcher.isPipeLive(this.pid)) {
          this.injected = true;
          this._method = this._method || 'reconnect';
          this.log.trace(
            'hook_session_branch pid=%d operation=load branch=existing_pipe method=%j',
            this.pid,
            this._method,
          );
          this.log.info('PID=%d already has SnowLuma pipe; will reconnect', this.pid);
        } else {
          this.log.trace(
            'hook_session_branch pid=%d operation=load branch=inject_begin',
            this.pid,
          );
          this.injectResult = await this.injector.inject(this.pid);
          this.injected = true;
          this._method = this.injectResult.method;
          this.log.trace(
            'hook_session_branch pid=%d operation=load branch=inject_completed method=%j',
            this.pid,
            this._method,
          );
        }
      }
      this.applyStatus();
    } catch (error) {
      this._error = errMsg(error);
      this.setStatus('error', this._error);
      this.log.error('load failed: PID=%d err=%s', this.pid, this._error);
    }
    return this.toInfo();
  }

  private async unloadInternal(): Promise<HookProcessInfo> {
    this._error = '';
    try {
      const wasLoggedIn = this.loggedIn;
      this.tearDownClient();
      if (wasLoggedIn) this.emit('disconnected', true);

      const handle = this.injectResult?.handle;
      if (this.injected && handle) {
        this.injector.unload(this.pid, handle);
        this.log.info('SnowLuma unloaded from PID=%d', this.pid);
      }

      this.injected = false;
      this.injectResult = null;
      this._method = '';
      this._uin = '0';

      // Verify the unload took: if the pipe is still up the DLL is still
      // resident. The cached snapshot is up to 1500ms stale and we just
      // changed the world, so force a fresh poll first — otherwise even
      // a successful unload reads as "pipe still live" until the next
      // background tick runs and we'd report a spurious failure.
      await this.pipeWatcher.tickNow?.();
      if (this.pipeWatcher.isPipeLive(this.pid)) {
        this._error = 'DLL卸载失败：命名管道仍然存在，watcher将自动重连';
        this.setStatus('connecting', this._error);
        this.log.warn('unload verification failed: PID=%d pipe still up', this.pid);
      } else {
        this.setStatus('available', '');
      }
    } catch (error) {
      this._error = errMsg(error);
      this.setStatus('error', this._error);
      this.log.error('unload failed: PID=%d err=%s', this.pid, this._error);
    }
    return this.toInfo();
  }

  private async refreshInternal(): Promise<HookProcessInfo> {
    this._error = '';
    try {
      // Same pipe-up / pipe-down reconcilers the watcher drives, chosen by
      // a fresh poll. This collapses what used to be a hand-copied pair of
      // onPipeUp/onPipeDown bodies — and fixes the drift where the down
      // branch reported 'disconnected' even for a never-logged-in session.
      if (this.pipeWatcher.isPipeLive(this.pid)) {
        await this.reconcilePipeUp();
      } else {
        this.reconcilePipeDown();
      }
    } catch (error) {
      this._error = errMsg(error);
      this.setStatus(this.injected ? 'disconnected' : 'error', this._error);
      this.log.warn('refresh failed: PID=%d err=%s', this.pid, this._error);
    }
    return this.toInfo();
  }

  // ─────────────── settled-status reconcilers ───────────────

  /** Push the settled status derived from the live flags. `wasLoggedIn`
   * defaults to the current `loggedIn`; callers that just tore the client
   * down pass the value captured *before* teardown (teardown clears it). */
  private applyStatus(wasLoggedIn: boolean = this.loggedIn, error = ''): void {
    this.setStatus(statusFor({
      injected: this.injected,
      connected: this.connected,
      loggedIn: this.loggedIn,
      wasLoggedIn,
    }), error);
  }

  /** Pipe is up: adopt a DLL that survived a SnowLuma restart, drop a
   * stale client, then (re)connect if needed or just settle the status.
   * Shared by onPipeUp and refresh's pipe-up branch. */
  private async reconcilePipeUp(): Promise<void> {
    if (!this.injected) {
      this.injected = true;
      if (!this._method) this._method = 'reconnect';
    }
    if (this.client?.isClosed) this.tearDownClient();
    if (!this.connected) {
      await this.attemptConnect();
    } else {
      this.applyStatus();
    }
  }

  /** Pipe is down (or the client closed): tear down, settle the status,
   * and emit the disconnect notification iff we owed BridgeManager one
   * (i.e. we had reached login). Shared by onPipeDown, refresh's pipe-down
   * branch, and the client 'close' handler. */
  private reconcilePipeDown(): void {
    if (!this.connected) {
      // Nothing live to tear down. A session that never connected can't owe
      // a disconnect, and we must NOT clobber a diagnostic the failed
      // connect/load already set — settle the status keeping `_error`, or
      // (when not even injected) leave the status untouched entirely.
      if (this.injected) this.applyStatus(this.loggedIn, this._error);
      return;
    }
    runWithTraceRequest(() => {
      const startedAt = Date.now();
      const wasLoggedIn = this.loggedIn;
      this.log.trace(() => [
        'hook_session_disconnect_start pid=%d reason=pipe_down state=%s',
        this.pid,
        renderParamsVerbose(this.toInfo()),
      ]);
      this.tearDownClient();
      this.applyStatus(wasLoggedIn);
      try {
        if (wasLoggedIn) this.emit('disconnected', true);
        this.log.trace(() => [
          'hook_session_disconnect_terminal pid=%d outcome=completed reason=pipe_down wasLoggedIn=%s state=%s elapsedMs=%d',
          this.pid,
          wasLoggedIn,
          renderParamsVerbose(this.toInfo()),
          Date.now() - startedAt,
        ]);
      } catch (error) {
        this.log.trace(() => [
          'hook_session_disconnect_terminal pid=%d outcome=failed reason=listener_failed error=%j state=%s elapsedMs=%d',
          this.pid,
          errMsg(error),
          renderParamsVerbose(this.toInfo()),
          Date.now() - startedAt,
        ]);
        throw error;
      }
    });
  }

  // ─────────────── client plumbing ───────────────

  private async attemptConnect(): Promise<void> {
    if (this.connected) return;
    return runWithTraceRequest(async () => {
      const startedAt = Date.now();
      this.log.trace(() => [
        'hook_session_connect_start pid=%d state=%s',
        this.pid,
        renderParamsVerbose(this.toInfo()),
      ]);
      if (this.client?.isClosed) this.tearDownClient();
      if (!this.client) {
        this.client = this.makeClient(this.pid);
        this.sender = new HookPacketClient(this.client);
        this.bound = false;
      }
      if (!this.bound) {
        this.bindClient(this.client);
        this.bound = true;
      }

      const client = this.client;
      try {
        await client.connectAll({ recv: true });
        this.connected = true;
        const loginState = client.getLoginState();
        // handleLoginState owns the connected+loggedIn → 'online' (+ login
        // emit) transition; defer to it so the status is set once. Otherwise
        // we're connected-but-not-logged-in → 'loaded'.
        if (loginState.loggedIn) {
          this.handleLoginState(loginState);
        } else {
          this.applyStatus();
          // The native hook only PUSHES a loginState frame on the login edge;
          // if QQ logged in before/around connect (Docker auto-login) that edge
          // is missed and we'd wait forever. Actively re-probe until logged in.
          runWithoutRequestContext(() => this.startLoginReconcile());
        }
        this.log.info('pipe connected: PID=%d', this.pid);
        this.log.trace(() => [
          'hook_session_connect_terminal pid=%d outcome=completed reason=connect_settled state=%s elapsedMs=%d',
          this.pid,
          renderParamsVerbose(this.toInfo()),
          Date.now() - startedAt,
        ]);
      } catch (error) {
        this._error = errMsg(error);
        // Drop the client so the next attempt builds a fresh socket pair.
        // A failed connect was never logged in → 'connecting' (or 'available').
        this.tearDownClient();
        this.applyStatus(false, this._error);
        this.log.trace(() => [
          'hook_session_connect_terminal pid=%d outcome=failed reason=connect_failed error=%j state=%s elapsedMs=%d',
          this.pid,
          this._error,
          renderParamsVerbose(this.toInfo()),
          Date.now() - startedAt,
        ]);
      }
    });
  }

  private bindClient(client: QqHookClient): void {
    client.on('packet', packet => this.handlePacket(packet));
    client.on('loginState', state => this.handleLoginState(state));
    client.on('error', error => {
      const msg = errMsg(error);
      this._error = msg;
      this.log.warn('pipe error: PID=%d err=%s', this.pid, msg);
    });
    client.on('close', () => {
      if (this.disposed) return;
      // Only the currently-registered client should drive a reconcile;
      // listeners may fire for an already-replaced client.
      if (this.client !== client) return;
      void this.serialize(async () => {
        if (this.disposed) return;
        if (this.client !== client) return;
        this.reconcilePipeDown();
      }).catch(err => this.log.warn('close reconcile failed: PID=%d err=%s', this.pid, errMsg(err)));
    });
  }

  private tearDownClient(): void {
    this.stopLoginReconcile();
    this.resetReceiveWatch();
    const client = this.client;
    if (client) {
      client.removeAllListeners();
      try { client.close(); } catch { /* ignore */ }
    }
    this.client = null;
    this.sender = null;
    this.bound = false;
    this.connected = false;
    this.loggedIn = false;
    this.resetLoginHint();
  }

  private handleLoginState(state: QqHookLoginState): void {
    const wasLoggedIn = this.loggedIn;
    const previousUin = this._uin;
    this._uin = state.uin || state.uinNumber.toString();
    this.loggedIn = state.loggedIn && isRealUin(this._uin);
    // Login readiness has now been confirmed, so identity probing is done.
    if (this.loggedIn) {
      this.stopLoginReconcile();
      // A PID can switch accounts without an intermediate logout edge. Never
      // carry the previous account's heartbeat deadline into the new epoch.
      if (this.receiveWatchUin !== this._uin) this.resetReceiveWatch(this._uin);
    } else {
      this.resetReceiveWatch();
    }

    // Only the connected/logged-in states are ours to set here; when fully
    // down we leave the status the teardown path already settled.
    // Load-bearing invariant: `loggedIn ⇒ connected` (login can only be
    // observed on a live client, and teardown clears `loggedIn` before
    // `connected`), so statusFor lands 'online' here rather than the
    // disconnected/connecting branch.
    if (this.connected || this.loggedIn) {
      this.applyStatus(wasLoggedIn, this.loggedIn ? '' : this._error);
    }

    if (!this.loggedIn || !this.sender) return;
    if (wasLoggedIn && previousUin === this._uin) return;

    runWithTraceRequest(() => {
      const startedAt = Date.now();
      this.log.trace(
        'hook_session_login_start pid=%d previousUin=%j uin=%j',
        this.pid,
        previousUin,
        this._uin,
      );
      try {
        this.emit('login', this._uin, this.sender!);
        this.log.success('login detected: PID=%d UIN=%s', this.pid, this._uin);
        this.log.trace(() => [
          'hook_session_login_terminal pid=%d outcome=completed reason=login_detected previousUin=%j uin=%j state=%s elapsedMs=%d',
          this.pid,
          previousUin,
          this._uin,
          renderParamsVerbose(this.toInfo()),
          Date.now() - startedAt,
        ]);
      } catch (error) {
        this.log.trace(() => [
          'hook_session_login_terminal pid=%d outcome=failed reason=listener_failed error=%j state=%s elapsedMs=%d',
          this.pid,
          errMsg(error),
          renderParamsVerbose(this.toInfo()),
          Date.now() - startedAt,
        ]);
        throw error;
      }
    });
  }

  // ─────────────── login reconcile (Docker auto-login safety net) ───────────
  // The local endpoint can identify an auto-restored account before the
  // runtime is ready. Forward identity for reconciliation, but never synthesize
  // online state from the probe.

  private startLoginReconcile(): void {
    if (this.loginProbeTimer || this.disposed) return;
    void this.probeLoginOnce(); // immediate — catch already-logged-in fast
    this.loginProbeTimer = setInterval(() => void this.probeLoginOnce(), LOGIN_RECONCILE_INTERVAL_MS);
    this.loginProbeTimer.unref?.();
  }

  private stopLoginReconcile(): void {
    if (this.loginProbeTimer) {
      clearInterval(this.loginProbeTimer);
      this.loginProbeTimer = null;
    }
  }

  private async probeLoginOnce(): Promise<void> {
    // A port-scan probe can outlast the interval; skip overlapping ticks so a
    // slow probe never stacks concurrent subprocess-spawning scans.
    if (this.probing) return;
    if (this.disposed || !this.connected || this.loggedIn) { this.stopLoginReconcile(); return; }
    if (Date.now() < this.nextLoginIdentityObservationAt) return;
    this.probing = true;
    try {
      let info: QqPortLoginInfo | null;
      try {
        info = await this.probeLogin(this.pid);
      } catch (error) {
        this.log.trace(
          'login identity probe failed: PID=%d err=%s',
          this.pid,
          errMsg(error),
        );
        return; // best-effort; the interval retries
      }
      // The await yielded — re-check we still want this before mutating state.
      if (this.disposed || !this.connected || this.loggedIn) { this.stopLoginReconcile(); return; }
      if (info?.loggedIn && isRealUin(info.uin)) {
        const client = this.client;
        if (!client) return;
        if (this.acceptedLoginHintUin === info.uin) {
          this.nextLoginIdentityObservationAt = Date.now()
            + LOGIN_IDENTITY_OBSERVE_INTERVAL_MS;
          return;
        }
        if (this.loginHintAttemptUin !== info.uin) {
          this.loginHintAttemptUin = info.uin;
          this.loginHintAttempts = 0;
          this.nextLoginHintAt = 0;
          this.nextLoginIdentityObservationAt = 0;
        }
        if (this.loginHintAttempts >= LOGIN_HINT_MAX_ATTEMPTS
          || Date.now() < this.nextLoginHintAt) return;

        const attempt = ++this.loginHintAttempts;
        this.log.info('login identity discovered: PID=%d UIN=%s; awaiting readiness', this.pid, info.uin);
        try {
          await client.reconcileLoginIdentity(info.uin);
          if (this.client !== client || this.disposed || !this.connected || this.loggedIn) return;
          this.acceptedLoginHintUin = info.uin;
          this.nextLoginIdentityObservationAt = Date.now()
            + LOGIN_IDENTITY_OBSERVE_INTERVAL_MS;
        } catch (error) {
          if (this.client !== client || this.disposed) return;
          if (attempt >= LOGIN_HINT_MAX_ATTEMPTS) {
            this.log.warn(
              'login identity reconciliation failed: PID=%d UIN=%s attempts=%d err=%s',
              this.pid,
              info.uin,
              attempt,
              errMsg(error),
            );
            this.nextLoginIdentityObservationAt = Date.now()
              + LOGIN_IDENTITY_OBSERVE_INTERVAL_MS;
          } else {
            this.nextLoginHintAt = Date.now()
              + LOGIN_HINT_RETRY_DELAYS_MS[attempt - 1]!;
            this.log.trace(
              'login identity hint failed: PID=%d UIN=%s attempt=%d err=%s',
              this.pid,
              info.uin,
              attempt,
              errMsg(error),
            );
          }
        }
      }
    } finally {
      this.probing = false;
    }
  }

  private resetLoginHint(): void {
    this.acceptedLoginHintUin = '';
    this.loginHintAttemptUin = '';
    this.loginHintAttempts = 0;
    this.nextLoginHintAt = 0;
    this.nextLoginIdentityObservationAt = 0;
  }

  private handlePacket(packet: QqHookPacket): void {
    if (!this.loggedIn) return;
    const uin = packet.uin || this._uin;
    // Routing requires a real UIN, but even a frame carrying UIN=0 proves the
    // receive hook is alive. Attribute that evidence to the current epoch
    // without forwarding the malformed packet into BridgeManager.
    const receiveUin = isRealUin(uin) ? uin : (this.receiveWatchUin || this._uin);
    if (isRealUin(receiveUin)) this.noteReceiveActivity(packet.cmd, receiveUin);
    if (!isRealUin(uin)) return;
    if (!this.onPacket) return;
    // Re-shape the hook-client wire packet into BridgeManager's PacketInfo
    // shape. Used to live in the deleted NtqqHandler.onHookPacket; field
    // renaming was that module's entire purpose, so it lives at the source
    // now (no need for a single-listener event-emitter in between).
    this.onPacket({
      pid: this.pid,
      uin,
      serviceCmd: packet.cmd,
      seqId: packet.seq,
      retCode: packet.error,
      fromClient: false,
      body: Buffer.from(packet.body),
    });
  }

  private setStatus(status: HookProcessStatus, error: string): void {
    if (this._status === status && this._error === error) return;
    this._status = status;
    this._error = error;
    this.emit('status-changed', status, error);
  }

  private noteReceiveActivity(cmd: string, uin: string): void {
    // BridgeManager treats packet.uin as authoritative and may move this PID
    // before the next loginState edge. Keep the watchdog on that same epoch.
    if (this.receiveWatchUin !== uin) this.resetReceiveWatch(uin);

    if (!this.receiveWatchArmed) {
      if (cmd !== QQ_RECV_HEARTBEAT_CMD) return;
      this.receiveWatchArmed = true;
      this.log.debug('receive health armed by QQ heartbeat: PID=%d UIN=%s', this.pid, this.receiveWatchUin);
    }

    const now = Date.now();
    const silentForMs = this.lastReceiveAt > 0 ? now - this.lastReceiveAt : 0;
    this.lastReceiveAt = now;
    this.scheduleReceiveStaleCheck();

    if (!this._receiveHealthy) {
      this.setReceiveHealthy(true);
      this.log.info(
        'receive path recovered: PID=%d UIN=%s silentFor=%dms',
        this.pid,
        this.receiveWatchUin,
        silentForMs,
      );
    }
  }

  private scheduleReceiveStaleCheck(): void {
    if (this.receiveWatchTimer) clearTimeout(this.receiveWatchTimer);
    this.receiveWatchTimer = setTimeout(() => {
      this.receiveWatchTimer = null;
      if (!this.shouldWatchReceive()) return;

      // A delayed event loop (notably system sleep/resume) lands here long
      // after the nominal 90s deadline. Do not flip health immediately: give
      // the real QQ heartbeat one short confirmation window to arrive.
      this.receiveWatchTimer = setTimeout(() => {
        this.receiveWatchTimer = null;
        if (!this.shouldWatchReceive()) return;
        const silentForMs = Date.now() - this.lastReceiveAt;
        if (silentForMs < RECEIVE_STALE_AFTER_MS + RECEIVE_STALE_CONFIRM_MS) {
          this.scheduleReceiveStaleCheck();
          return;
        }
        this.setReceiveHealthy(false);
        this.log.warn(
          'receive path stale: PID=%d UIN=%s lastRecvAt=%s silentFor=%dms; reporting good=false',
          this.pid,
          this.receiveWatchUin,
          new Date(this.lastReceiveAt).toISOString(),
          silentForMs,
        );
      }, RECEIVE_STALE_CONFIRM_MS);
      this.receiveWatchTimer.unref?.();
    }, RECEIVE_STALE_AFTER_MS);
    this.receiveWatchTimer.unref?.();
  }

  private shouldWatchReceive(): boolean {
    return !this.disposed && this.connected && this.loggedIn && this.receiveWatchArmed;
  }

  private setReceiveHealthy(healthy: boolean): void {
    if (this._receiveHealthy === healthy) return;
    this._receiveHealthy = healthy;
    this.emit('receive-health-changed', healthy);
  }

  private resetReceiveWatch(uin = ''): void {
    if (this.receiveWatchTimer) {
      clearTimeout(this.receiveWatchTimer);
      this.receiveWatchTimer = null;
    }
    this.receiveWatchUin = uin;
    this.receiveWatchArmed = false;
    this.lastReceiveAt = 0;
    this._receiveHealthy = true;
  }
}

function errMsg(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
