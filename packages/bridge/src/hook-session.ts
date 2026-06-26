import { createLogger, type Logger } from '@snowluma/common/logger';
import type { PacketSink } from '@snowluma/common/protocol-types';
import { EventEmitter } from 'events';
import { HookPacketClient } from './hook-packet-client';
import type { HookInjectResult } from './injector';
import type { QqHookClient, QqHookLoginState, QqHookPacket } from './qq-hook-client';
import { statusFor } from './hook-status';
import type { HookProcessInfo, HookProcessStatus } from './types';

export type HookSessionDeps = {
  injector: {
    inject: (pid: number) => HookInjectResult;
    unload: (pid: number, handle: HookInjectResult['handle']) => void;
  };
  makeClient: (pid: number) => QqHookClient;
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
 *   'status-changed' (status, error)     — status field mutated
 *   'disposed'       ()                  — session stopped tracking this PID
 */
export class HookSession extends EventEmitter {
  readonly pid: number;

  private readonly injector: HookSessionDeps['injector'];
  private readonly makeClient: HookSessionDeps['makeClient'];
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

  constructor(pid: number, deps: HookSessionDeps) {
    super();
    this.pid = pid;
    this.injector = deps.injector;
    this.makeClient = deps.makeClient;
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
    return this.serialize(() => this.loadInternal());
  }

  unload(): Promise<HookProcessInfo> {
    return this.serialize(() => this.unloadInternal());
  }

  refresh(): Promise<HookProcessInfo> {
    return this.serialize(() => this.refreshInternal());
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
      const wasLoggedIn = this.loggedIn;
      this.tearDownClient();
      this.injected = false;
      this.injectResult = null;
      this._method = '';
      this.setStatus('available', '');
      if (wasLoggedIn) this.emit('disconnected', true);
      this.disposed = true;
      this.emit('disposed');
      this.removeAllListeners();
    }).catch(err => this.log.warn('notifyProcessGone failed: PID=%d err=%s', this.pid, errMsg(err)));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tearDownClient();
    this.removeAllListeners();
  }

  // ─────────────── per-session serialization ───────────────

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
          this.log.info('PID=%d already has SnowLuma pipe; will reconnect', this.pid);
        } else {
          this.injectResult = this.injector.inject(this.pid);
          this.injected = true;
          this._method = this.injectResult.method;
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
    const wasLoggedIn = this.loggedIn;
    this.tearDownClient();
    this.applyStatus(wasLoggedIn);
    if (wasLoggedIn) this.emit('disconnected', true);
  }

  // ─────────────── client plumbing ───────────────

  private async attemptConnect(): Promise<void> {
    if (this.connected) return;
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
      if (loginState.loggedIn) this.handleLoginState(loginState);
      else this.applyStatus();
      this.log.info('pipe connected: PID=%d', this.pid);
    } catch (error) {
      this._error = errMsg(error);
      // Drop the client so the next attempt builds a fresh socket pair.
      // A failed connect was never logged in → 'connecting' (or 'available').
      this.tearDownClient();
      this.applyStatus(false, this._error);
    }
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
  }

  private handleLoginState(state: QqHookLoginState): void {
    const wasLoggedIn = this.loggedIn;
    const previousUin = this._uin;
    this._uin = state.uin || state.uinNumber.toString();
    this.loggedIn = state.loggedIn && isRealUin(this._uin);

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

    this.emit('login', this._uin, this.sender);
    this.log.success('login detected: PID=%d UIN=%s', this.pid, this._uin);
  }

  private handlePacket(packet: QqHookPacket): void {
    if (!this.loggedIn) return;
    const uin = packet.uin || this._uin;
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
}

function isRealUin(uin: string): boolean {
  if (!uin || uin === '0') return false;
  return /^\d+$/.test(uin) && uin.length >= 5;
}

function errMsg(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
