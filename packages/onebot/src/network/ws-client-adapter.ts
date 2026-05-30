import { WebSocket } from '@snowluma/websocket';
import { createLogger, type Logger } from '@snowluma/common/logger';
import {
  pickDispatchJson,
  resolveReportOptions,
  shapeEventForAdapter,
  type DispatchPayload,
  type EventReportOptions,
} from '../event-filter';
import type { JsonObject, WsClientNetwork, WsRole } from '../types';
import { IOneBotNetworkAdapter, NetworkReloadType, type AdapterStatus, type NetworkAdapterContext } from './adapter';
import { rawDataToString, safeClose, safeSend } from './utils';

const moduleLog = createLogger('OneBot.WS-Client');
const DEFAULT_RECONNECT_INTERVAL_MS = 5000;

export class WsClientAdapter extends IOneBotNetworkAdapter<WsClientNetwork> {
  private socket: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private options: EventReportOptions;
  private role: WsRole;
  private explicitlyClosed = false;
  private readonly log: Logger;

  constructor(name: string, config: WsClientNetwork, ctx: NetworkAdapterContext) {
    super(name, config, ctx);
    this.options = resolveReportOptions(config);
    this.role = config.role ?? 'Universal';
    const uinNum = Number.parseInt(ctx.uin, 10);
    this.log = Number.isFinite(uinNum) && uinNum > 0 ? moduleLog.child({ uin: uinNum }) : moduleLog;
  }

  override get isActive(): boolean {
    return this.isEnabled;
  }

  open(): void {
    if (this.isEnabled) return;
    if (this.config.enabled === false) return;
    if (!this.config.url) return;
    this.explicitlyClosed = false;
    this.isEnabled = true;
    this.connect();
  }

  close(): void {
    this.explicitlyClosed = true;
    this.isEnabled = false;
    this.connected = false;
    this.cancelReconnect();
    if (this.socket) {
      safeClose(this.socket);
      this.socket = null;
    }
  }

  override describeStatus(): AdapterStatus {
    if (!this.isEnabled) return { name: this.name, kind: 'wsClient', status: 'disabled', detail: '未启用' };
    if (this.connected) return { name: this.name, kind: 'wsClient', status: 'ok', detail: '已连接' };
    return { name: this.name, kind: 'wsClient', status: 'warn', detail: this.reconnectTimer ? '重连中' : '连接中' };
  }

  async reload(next: WsClientNetwork): Promise<NetworkReloadType> {
    const prevSig = bindingSignature(this.config);
    const wasEnabled = this.isEnabled;
    const willEnable = next.enabled !== false && !!next.url;

    this.config = structuredClone(next);
    this.options = resolveReportOptions(next);
    this.role = next.role ?? 'Universal';

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

    socket.on('open', () => {
      this.connected = true;
      this.log.info('[%s] connected %s', this.name, this.config.url);
      this.sendBootstrapMetaEvents(socket);
    });

    socket.on('message', (raw: Buffer) => {
      void this.handleApiMessage(socket, raw).catch((err) => {
        this.log.warn('[%s] handleApiMessage threw: %s', this.name, err instanceof Error ? (err.stack ?? err.message) : String(err));
      });
    });

    socket.on('close', () => {
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
    const response = await this.ctx.api.processRequest(text);
    safeSend(socket, response);
  }

  private sendBootstrapMetaEvents(socket: WebSocket): void {
    if (this.role !== 'Event' && this.role !== 'Universal') return;
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

function bindingSignature(net: WsClientNetwork): string {
  return `${net.url}#${net.role ?? 'Universal'}#${Math.max(1000, net.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS)}#${net.accessToken ?? ''}`;
}
