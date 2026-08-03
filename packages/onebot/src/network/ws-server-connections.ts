import type { Logger } from '@snowluma/common/logger';
import type { WebSocket } from '@snowluma/websocket';
import type { IncomingMessage } from 'node:http';
import {
  pickDispatchJson,
  resolveReportOptions,
  type DispatchPayload,
  type EventReportOptions,
} from '../event-filter';
import type { JsonObject, NetworkBase, WsRole } from '../types';
import type { NetworkAdapterContext } from './adapter';
import {
  isAuthorized,
  parseRequestPath,
  rawDataToString,
  safeClose,
  safeSend,
  safeSendAsync,
  startHeartbeat,
} from './utils';

// Transport keepalive for each attached client, symmetric with the ws-client
// adapter: ping every 30s, reap a client only after 2 consecutive pings go
// unanswered — ~90s of total silence (see startHeartbeat for the +1-interval
// timing). Any inbound frame resets the counter — see issue #208.
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_MAX_MISSED = 2;
const HEARTBEAT_DEAD_AFTER_S = (HEARTBEAT_INTERVAL_MS * (HEARTBEAT_MAX_MISSED + 1)) / 1000;

export type WsServerConnectionConfig = NetworkBase & { role?: WsRole };

interface ForwardConnection {
  socket: WebSocket;
  role: WsRole;
  options: EventReportOptions;
  stopHeartbeat: () => void;
}

interface MetaFrames {
  frame(event: JsonObject, options: EventReportOptions): string | null;
  bootstrap(options: EventReportOptions): string[];
}

/**
 * Shared OneBot WebSocket session owner.
 *
 * Listener ownership deliberately stays in the network adapter: a standalone
 * WS adapter owns its TCP listener, while an HTTP adapter owns the shared
 * listener and only attaches an upgrade handler. This class owns everything
 * after a WebSocket connection is accepted so both transports keep identical
 * auth, role, event, heartbeat, stream, and shutdown semantics.
 */
export class WsServerConnections {
  private acceptingActions = false;
  private readonly inFlightActions = new Set<Promise<void>>();
  private readonly connections = new Map<WebSocket, ForwardConnection>();
  private config: WsServerConnectionConfig;
  private options: EventReportOptions;

  constructor(
    private readonly name: string,
    config: WsServerConnectionConfig,
    private readonly ctx: NetworkAdapterContext,
    private readonly log: Logger,
    private readonly meta: MetaFrames,
  ) {
    this.config = structuredClone(config);
    this.options = resolveReportOptions(config);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get isAcceptingActions(): boolean {
    return this.acceptingActions;
  }

  get hasInFlightActions(): boolean {
    return this.inFlightActions.size > 0;
  }

  startAccepting(): void {
    this.acceptingActions = true;
  }

  stopAccepting(): void {
    this.acceptingActions = false;
  }

  updateConfig(next: WsServerConnectionConfig): void {
    const tokenChanged = (this.config.accessToken ?? '') !== (next.accessToken ?? '');
    this.config = structuredClone(next);
    this.options = resolveReportOptions(next);
    for (const connection of this.connections.values()) connection.options = this.options;

    // An already-authorized socket must not retain access after token
    // rotation. Drop it immediately; the client can reconnect with the new
    // credential without forcing the shared HTTP listener to rebind.
    if (tokenChanged) this.disconnectAll(1008, 'access token changed');
  }

  onEvent(payload: DispatchPayload): void {
    if (!this.acceptingActions || this.connections.size === 0) return;
    for (const connection of this.connections.values()) {
      if (connection.role !== 'Event' && connection.role !== 'Universal') continue;
      const json = pickDispatchJson(payload, connection.options);
      if (json === null) continue;
      safeSend(connection.socket, json);
    }
  }

  /** Authenticate the HTTP upgrade before a WebSocket object is allocated. */
  authorizeUpgrade(request: IncomingMessage): boolean {
    const authorized = isAuthorized(request, this.config.accessToken ?? '');
    if (!authorized) this.log.debug('[%s] rejected unauthorized WebSocket upgrade', this.name);
    return authorized;
  }

  accept(socket: WebSocket, request: IncomingMessage): void {
    if (!this.acceptingActions || this.ctx.api.isAcceptingActions === false) {
      safeClose(socket, 1012, 'server closing');
      return;
    }
    // Defence in depth for custom/future listeners that bypass verifyClient.
    if (!this.authorizeUpgrade(request)) {
      safeClose(socket, 1008, 'invalid access token');
      return;
    }

    const role = this.config.role ?? classifyForwardRole(request);
    const stopHeartbeat = startHeartbeat(
      socket,
      { intervalMs: HEARTBEAT_INTERVAL_MS, maxMissed: HEARTBEAT_MAX_MISSED },
      () => {
        this.log.warn(
          '[%s] client silent for ~%ds, terminating half-open connection',
          this.name,
          HEARTBEAT_DEAD_AFTER_S,
        );
        socket.terminate();
      },
    );
    const connection: ForwardConnection = {
      socket,
      role,
      options: this.options,
      stopHeartbeat,
    };
    this.connections.set(socket, connection);

    socket.on('message', (raw: Buffer) => {
      // Token rotation removes the connection synchronously, before the close
      // handshake necessarily reaches the peer. Ignore any frame arriving in
      // that interval so old credentials cannot start another Action.
      if (!this.connections.has(socket)) return;
      if (this.ctx.api.isAcceptingActions === false) {
        this.log.warn('[%s] rejected inbound action after instance quiesce', this.name);
        if (role === 'Api' || role === 'Universal') {
          const text = rawDataToString(raw);
          if (text) this.ctx.api.traceQuiescedStreamRequest(text);
        }
        return;
      }
      this.trackInboundAction(() => this.handleApiMessage(socket, role, raw));
    });
    socket.on('close', () => {
      stopHeartbeat();
      this.connections.delete(socket);
    });
    socket.on('error', (error: Error) => {
      this.log.warn(
        '[%s] socket error: %s',
        this.name,
        error instanceof Error ? error.message : String(error),
      );
    });

    if (role === 'Event' || role === 'Universal') {
      for (const frame of this.meta.bootstrap(this.options)) safeSend(socket, frame);
    }
  }

  async closeConnections(): Promise<void> {
    this.stopAccepting();
    const lifecycle = this.ctx.buildLifecycleEvent('disable');
    for (const connection of this.connections.values()) {
      if (connection.role === 'Api') continue;
      const frame = this.meta.frame(lifecycle, connection.options);
      if (frame) safeSend(connection.socket, frame);
    }
    this.disconnectAll();
    await Promise.all(this.inFlightActions);
  }

  private disconnectAll(code = 1000, reason = 'normal'): void {
    for (const connection of this.connections.values()) {
      connection.stopHeartbeat();
      safeClose(connection.socket, code, reason);
    }
    this.connections.clear();
  }

  private async handleApiMessage(socket: WebSocket, role: WsRole, raw: Buffer | string): Promise<void> {
    const text = rawDataToString(raw);
    if (!text) {
      this.log.debug('[%s] ignored empty WebSocket frame', this.name);
      return;
    }
    if (role !== 'Api' && role !== 'Universal') {
      this.log.warn('[%s] rejected Action frame from Event-only connection', this.name);
      return;
    }
    await this.ctx.api.processStreamRequest(
      text,
      (frame) => safeSendAsync(socket, frame),
      () => socket.readyState === 1 && this.connections.has(socket),
    );
  }

  trackInboundAction(start: () => Promise<void>): void {
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
      this.log.error(
        '[%s] inbound action start failed: %s',
        this.name,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      return;
    }
    const tracked = action.then(
      () => undefined,
      (error) => {
        this.log.error(
          '[%s] inbound action failed: %s',
          this.name,
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        );
      },
    );
    this.inFlightActions.add(tracked);
    void tracked.then(() => { this.inFlightActions.delete(tracked); });
  }
}

function classifyForwardRole(request: IncomingMessage): WsRole {
  const path = parseRequestPath(request.url ?? '/');
  if (path.endsWith('/api')) return 'Api';
  if (path.endsWith('/event')) return 'Event';
  return 'Universal';
}
