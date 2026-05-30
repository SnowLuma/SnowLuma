import { WebSocket, WebSocketServer } from '@snowluma/websocket';
import type { IncomingMessage } from 'http';
import { createLogger, type Logger } from '@snowluma/common/logger';
import {
  pickDispatchJson,
  resolveReportOptions,
  shapeEventForAdapter,
  type DispatchPayload,
  type EventReportOptions,
} from '../event-filter';
import type { JsonObject, WsRole, WsServerNetwork } from '../types';
import { IOneBotNetworkAdapter, NetworkReloadType, type AdapterStatus, type NetworkAdapterContext } from './adapter';
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
  private readonly log: Logger;

  constructor(name: string, config: WsServerNetwork, ctx: NetworkAdapterContext) {
    super(name, config, ctx);
    this.options = resolveReportOptions(config);
    const uinNum = Number.parseInt(ctx.uin, 10);
    this.log = Number.isFinite(uinNum) && uinNum > 0 ? moduleLog.child({ uin: uinNum }) : moduleLog;
  }

  override get isActive(): boolean {
    return this.isEnabled;
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
      const shaped = shapeEventForAdapter(lifecycle, conn.options);
      if (!shaped) continue;
      safeSend(conn.socket, JSON.stringify(shaped));
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

  async reload(next: WsServerNetwork): Promise<NetworkReloadType> {
    const prevSig = bindingSignature(this.config);
    const wasEnabled = this.isEnabled;
    const willEnable = next.enabled !== false;

    this.config = structuredClone(next);
    this.options = resolveReportOptions(next);
    for (const conn of this.connections.values()) conn.options = this.options;

    const sigChanged = prevSig !== bindingSignature(next);
    if (sigChanged && wasEnabled) {
      this.close();
      if (willEnable) {
        this.open();
        return NetworkReloadType.Reopened;
      }
      return NetworkReloadType.Closed;
    }
    if (!wasEnabled && willEnable) {
      this.open();
      return NetworkReloadType.Opened;
    }
    if (wasEnabled && !willEnable) {
      this.close();
      return NetworkReloadType.Closed;
    }
    return NetworkReloadType.Normal;
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
    const events = [
      this.ctx.buildLifecycleEvent('connect'),
      this.ctx.buildLifecycleEvent('enable'),
      this.ctx.buildHeartbeatEvent(),
    ];
    for (const event of events) {
      const shaped = shapeEventForAdapter(event, this.options);
      if (!shaped) continue;
      safeSend(socket, JSON.stringify(shaped));
    }
  }
}

function classifyForwardRole(request: IncomingMessage): WsRole {
  const path = parseRequestPath(request.url ?? '/');
  if (path.endsWith('/api')) return 'Api';
  if (path.endsWith('/event')) return 'Event';
  return 'Universal';
}

function bindingSignature(net: WsServerNetwork): string {
  return `${net.host ?? '0.0.0.0'}:${net.port}${normalizePath(net.path)}#${net.role ?? 'auto'}#${net.accessToken ?? ''}`;
}
