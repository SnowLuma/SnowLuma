import { WebSocket, WebSocketServer } from '@snowluma/websocket';
import type { IncomingMessage } from 'http';
import { createLogger } from '@snowluma/common/logger';
import {
  pickDispatchJson,
  resolveReportOptions,
  type DispatchPayload,
  type EventReportOptions,
} from '../event-filter';
import type { JsonObject, WsRole, WsServerNetwork } from '../types';
import { IOneBotNetworkAdapter, type AdapterStatus, type NetworkAdapterContext } from './adapter';
import { isAuthorized, normalizePath, parseRequestPath, rawDataToString, safeClose, safeSend } from './utils';

const moduleLog = createLogger('OneBot.WS-Server');

interface ForwardConn {
  socket: WebSocket;
  role: WsRole;
  options: EventReportOptions;
}

export class WsServerAdapter extends IOneBotNetworkAdapter<WsServerNetwork> {
  private wss: WebSocketServer | null = null;
  private listening = false;
  private connections = new Map<WebSocket, ForwardConn>();
  private options: EventReportOptions;

  constructor(name: string, config: WsServerNetwork, ctx: NetworkAdapterContext) {
    super(name, config, ctx, moduleLog);
    this.options = resolveReportOptions(config);
  }

  open(): void {
    if (this.isEnabled) return;
    if (this.config.enabled === false) return;
    this.startServer();
    this.isEnabled = true;
  }

  close(): void {
    if (!this.isEnabled && this.connections.size === 0 && !this.wss) return;
    // Final lifecycle broadcast before tearing down so attached event clients
    // see the disable transition.
    const lifecycle = this.ctx.buildLifecycleEvent('disable');
    for (const conn of this.connections.values()) {
      if (conn.role === 'Api') continue;
      const frame = this.metaFrame(lifecycle, conn.options);
      if (frame) safeSend(conn.socket, frame);
    }

    this.isEnabled = false;
    this.listening = false;
    for (const ws of [...this.connections.keys()]) safeClose(ws);
    this.connections.clear();
    this.wss?.close();
    this.wss = null;
  }

  override describeStatus(): AdapterStatus {
    if (!this.isEnabled) return { name: this.name, kind: 'wsServer', status: 'disabled', detail: '未启用' };
    if (!this.listening) return { name: this.name, kind: 'wsServer', status: 'down', detail: '未监听（端口被占用？）' };
    return { name: this.name, kind: 'wsServer', status: 'ok', detail: `${this.connections.size} 个客户端` };
  }

  protected override bindingSignature(config: WsServerNetwork): string {
    return `${config.host ?? '0.0.0.0'}:${config.port}${normalizePath(config.path)}#${config.role ?? 'auto'}#${config.accessToken ?? ''}`;
  }

  protected override onConfigReplaced(next: WsServerNetwork): void {
    this.options = resolveReportOptions(next);
    for (const conn of this.connections.values()) conn.options = this.options;
  }

  onEvent(_event: JsonObject, payload: DispatchPayload): void {
    if (!this.isEnabled || this.connections.size === 0) return;
    for (const conn of this.connections.values()) {
      if (conn.role !== 'Event' && conn.role !== 'Universal') continue;
      const json = pickDispatchJson(payload, conn.options);
      if (json === null) continue;
      safeSend(conn.socket, json);
    }
  }

  private startServer(): void {
    const wss = new WebSocketServer({
      host: this.config.host ?? '0.0.0.0',
      port: this.config.port,
      path: this.config.path ?? '/',
    });
    this.wss = wss;

    wss.on('listening', () => {
      this.listening = true;
      this.log.success(
        '[%s] listening %s:%d%s',
        this.name,
        this.config.host ?? '0.0.0.0',
        this.config.port,
        this.config.path ?? '/',
      );
    });

    wss.on('error', (err: Error) => {
      this.listening = false;
      this.log.warn('[%s] server error: %s', this.name, err instanceof Error ? err.message : String(err));
    });

    wss.on('connection', (socket: WebSocket, request: IncomingMessage) => this.onConnection(socket, request));
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    if (!isAuthorized(request, this.config.accessToken ?? '')) {
      safeClose(socket, 1008, 'invalid access token');
      return;
    }

    const role = this.config.role ?? classifyForwardRole(request);
    const conn: ForwardConn = { socket, role, options: this.options };
    this.connections.set(socket, conn);

    socket.on('message', (raw: Buffer) => {
      void this.handleApiMessage(socket, role, raw);
    });
    socket.on('close', () => this.connections.delete(socket));
    socket.on('error', (err: Error) => {
      this.log.warn('[%s] socket error: %s', this.name, err instanceof Error ? err.message : String(err));
    });

    if (role === 'Event' || role === 'Universal') {
      this.sendBootstrapMetaEvents(socket);
    }
  }

  private async handleApiMessage(socket: WebSocket, role: WsRole, raw: Buffer | string): Promise<void> {
    if (role !== 'Api' && role !== 'Universal') return;
    const text = rawDataToString(raw);
    if (!text) return;
    const response = await this.ctx.api.processRequest(text);
    safeSend(socket, response);
  }

  private sendBootstrapMetaEvents(socket: WebSocket): void {
    for (const frame of this.bootstrapMetaFrames(this.options)) safeSend(socket, frame);
  }
}

function classifyForwardRole(request: IncomingMessage): WsRole {
  const path = parseRequestPath(request.url ?? '/');
  if (path.endsWith('/api')) return 'Api';
  if (path.endsWith('/event')) return 'Event';
  return 'Universal';
}
