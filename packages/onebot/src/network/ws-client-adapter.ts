import { WebSocket } from '@snowluma/websocket';
import { createLogger } from '@snowluma/common/logger';
import {
  pickDispatchJson,
  resolveReportOptions,
  type DispatchPayload,
  type EventReportOptions,
} from '../event-filter';
import type { JsonObject, WsClientNetwork, WsRole } from '../types';
import { IOneBotNetworkAdapter, type AdapterStatus, type NetworkAdapterContext } from './adapter';
import { rawDataToString, safeClose, safeSend, safeSendAsync, startHeartbeat } from './utils';

const moduleLog = createLogger('OneBot.WS-Client');
const DEFAULT_RECONNECT_INTERVAL_MS = 5000;
// Transport-level keepalive: ping every 30s, declare the link dead only after 2
// consecutive pings go unanswered — ~90s of total silence (see startHeartbeat
// for the +1-interval timing). Conservative on purpose so transient jitter/GC
// never reaps a healthy connection. See issue #208.
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_MAX_MISSED = 2;
const HEARTBEAT_DEAD_AFTER_S = (HEARTBEAT_INTERVAL_MS * (HEARTBEAT_MAX_MISSED + 1)) / 1000;

export class WsClientAdapter extends IOneBotNetworkAdapter<WsClientNetwork> {
  private socket: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private options: EventReportOptions;
  private role: WsRole;
  private explicitlyClosed = false;
  private acceptingActions = false;
  private readonly inFlightActions = new Set<Promise<void>>();
  // Stop fn for the CURRENT socket's keepalive, so close()/reload can halt it
  // immediately instead of waiting for the deferred 'close' event. The per-socket
  // closure in connect() still owns the #97 stale-socket case; this is idempotent
  // with it (both call the same stop).
  private heartbeatStop: (() => void) | null = null;

  constructor(name: string, config: WsClientNetwork, ctx: NetworkAdapterContext) {
    super(name, config, ctx, moduleLog);
    this.options = resolveReportOptions(config);
    this.role = config.role ?? 'Universal';
  }

  open(): void {
    if (this.isEnabled) return;
    if (this.config.enabled === false) return;
    if (!this.config.url) return;
    this.explicitlyClosed = false;
    this.isEnabled = true;
    try {
      this.connect();
      this.acceptingActions = true;
      this.clearApplyFailure();
    } catch (error) {
      this.isEnabled = false;
      this.explicitlyClosed = true;
      this.acceptingActions = false;
      this.recordTransportFailure(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.explicitlyClosed = true;
    this.acceptingActions = false;
    this.isEnabled = false;
    this.connected = false;
    this.cancelReconnect();
    this.heartbeatStop?.();
    this.heartbeatStop = null;
    if (this.socket) {
      safeClose(this.socket);
      this.socket = null;
    }
    await Promise.all(this.inFlightActions);
  }

  override describeStatus(): AdapterStatus {
    if (!this.isEnabled) return { name: this.name, kind: 'wsClient', status: 'disabled', detail: '未启用' };
    if (this.connected) return { name: this.name, kind: 'wsClient', status: 'ok', detail: '已连接' };
    return { name: this.name, kind: 'wsClient', status: 'warn', detail: this.reconnectTimer ? '重连中' : '连接中' };
  }

  protected override bindingSignature(config: WsClientNetwork): string {
    return `${config.url}#${config.role ?? 'Universal'}#${Math.max(1000, config.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS)}#${config.accessToken ?? ''}`;
  }

  protected override willEnable(config: WsClientNetwork): boolean {
    return config.enabled !== false && !!config.url;
  }

  protected override onConfigReplaced(next: WsClientNetwork): void {
    this.options = resolveReportOptions(next);
    this.role = next.role ?? 'Universal';
  }

  onEvent(_event: JsonObject, payload: DispatchPayload): void {
    if (!this.isEnabled || !this.socket) return;
    if (this.role !== 'Event' && this.role !== 'Universal') return;
    const json = pickDispatchJson(payload, this.options);
    if (json === null) return;
    safeSend(this.socket, json);
  }

  private connect(): void {
    if (this.explicitlyClosed) return;
    if (!this.config.url) return;
    if (this.socket) return;

    const headers: Record<string, string> = {
      'User-Agent': 'OneBot/11',
      'X-Self-ID': this.ctx.uin,
      'X-Client-Role': this.role,
    };
    if (this.config.accessToken) {
      headers.Authorization = `Bearer ${this.config.accessToken}`;
    }

    const socket = new WebSocket(this.config.url, { headers });
    this.socket = socket;
    // Per-socket so a hot-reload overlap (old close firing after the new socket
    // is assigned, see #97) can only ever stop its own keepalive.
    let stopHeartbeat: (() => void) | null = null;

    socket.on('open', () => {
      // Symmetric with the 'close' guard (#97): if this socket was already
      // replaced, a late 'open' must not flip `connected` or install a stale
      // heartbeat onto the current connection's slot.
      if (this.socket !== socket) return;
      this.connected = true;
      this.log.info('[%s] connected %s', this.name, this.config.url);
      this.sendBootstrapMetaEvents(socket);
      // Only meaningful once OPEN — ping() no-ops before the handshake completes.
      stopHeartbeat = startHeartbeat(
        socket,
        { intervalMs: HEARTBEAT_INTERVAL_MS, maxMissed: HEARTBEAT_MAX_MISSED },
        () => {
          if (this.explicitlyClosed || !this.isEnabled) return;
          this.log.warn('[%s] no inbound response for ~%ds, reconnecting half-open connection %s', this.name, HEARTBEAT_DEAD_AFTER_S, this.config.url);
          // terminate → 'close' → scheduleReconnect, reusing the normal path.
          socket.terminate();
        },
      );
      this.heartbeatStop = stopHeartbeat;
    });

    socket.on('message', (raw: Buffer) => {
      if (this.socket !== socket) {
        this.log.warn('[%s] rejected inbound action from stale socket', this.name);
        return;
      }
      if (this.ctx.api.isAcceptingActions === false) {
        this.log.warn('[%s] rejected inbound action after instance quiesce', this.name);
        if (this.role === 'Api' || this.role === 'Universal') {
          const text = rawDataToString(raw);
          if (text) this.ctx.api.traceQuiescedStreamRequest(text);
        }
        return;
      }
      this.trackInboundAction(() => this.handleApiMessage(socket, raw));
    });

    socket.on('close', () => {
      stopHeartbeat?.();
      // Drop the instance handle only if it still points at THIS socket's stop
      // (a newer socket may already own it after a hot-reload overlap).
      if (this.heartbeatStop === stopHeartbeat) this.heartbeatStop = null;
      stopHeartbeat = null;
      // Ignore close events from a socket that is no longer the current
      // connection. A hot reload (signature change) calls close() then open()
      // back-to-back; the old socket's `'close'` event fires AFTER the new
      // one is already assigned to `this.socket`, and without this guard it
      // would null out `this.socket`, drop `connected`, and schedule an
      // unwanted reconnect — observable as a reconnect storm against a
      // single-connection backend that kicks duplicates. See issue #97.
      if (this.socket !== socket) return;
      this.socket = null;
      this.connected = false;
      if (this.explicitlyClosed || !this.isEnabled) return;
      this.scheduleReconnect();
    });

    socket.on('error', (err: Error) => {
      this.log.warn('[%s] error %s: %s', this.name, this.config.url, err instanceof Error ? err.message : String(err));
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.explicitlyClosed) return;
    const interval = Math.max(1000, this.config.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS);
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.explicitlyClosed || !this.isEnabled) return;
      this.connect();
    }, interval);
    timer.unref?.();
    this.reconnectTimer = timer;
  }

  private cancelReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async handleApiMessage(socket: WebSocket, raw: Buffer | string): Promise<void> {
    if (this.role !== 'Api' && this.role !== 'Universal') return;
    const text = rawDataToString(raw);
    if (!text) return;
    // Stream API (#163): one frame for a normal action, N for a streaming one.
    // Async send = backpressure; liveness check aborts on disconnect.
    await this.ctx.api.processStreamRequest(
      text,
      (frame) => safeSendAsync(socket, frame),
      () => socket.readyState === 1,
    );
  }

  private trackInboundAction(start: () => Promise<void>): void {
    if (
      !this.acceptingActions
      || this.ctx.api.isAcceptingActions === false
    ) {
      this.log.warn('[%s] rejected inbound action while adapter is closing', this.name);
      return;
    }
    let action: Promise<void>;
    try {
      action = start();
    } catch (error) {
      this.log.error('[%s] inbound action start failed: %s', this.name, error instanceof Error ? (error.stack ?? error.message) : String(error));
      return;
    }
    const tracked = action.then(
      () => undefined,
      (error) => {
        this.log.error('[%s] inbound action failed: %s', this.name, error instanceof Error ? (error.stack ?? error.message) : String(error));
      },
    );
    this.inFlightActions.add(tracked);
    void tracked.then(() => { this.inFlightActions.delete(tracked); });
  }

  private sendBootstrapMetaEvents(socket: WebSocket): void {
    if (this.role !== 'Event' && this.role !== 'Universal') return;
    for (const frame of this.bootstrapMetaFrames(this.options)) safeSend(socket, frame);
  }
}
