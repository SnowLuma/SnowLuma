import { WebSocketServer } from '@snowluma/websocket';
import { createLogger } from '@snowluma/common/logger';
import type { DispatchPayload } from '../event-filter';
import type { JsonObject, WsServerNetwork } from '../types';
import { IOneBotNetworkAdapter, type AdapterStatus, type NetworkAdapterContext } from './adapter';
import { normalizePath } from './utils';
import { WsServerConnections } from './ws-server-connections';

const moduleLog = createLogger('OneBot.WS-Server');

export class WsServerAdapter extends IOneBotNetworkAdapter<WsServerNetwork> {
  private wss: WebSocketServer | null = null;
  private listening = false;
  private closePromise: Promise<void> | null = null;
  private readonly connections: WsServerConnections;

  constructor(name: string, config: WsServerNetwork, ctx: NetworkAdapterContext) {
    super(name, config, ctx, moduleLog);
    this.connections = new WsServerConnections(name, config, ctx, this.log, {
      frame: (event, options) => this.metaFrame(event, options),
      bootstrap: (options) => this.bootstrapMetaFrames(options),
    });
  }

  async open(): Promise<void> {
    if (this.isEnabled && this.listening) return;
    if (this.config.enabled === false) return;
    if (this.wss) throw new Error(`WebSocket adapter [${this.name}] still owns a previous server`);
    await this.startServer();
    this.isEnabled = true;
    this.clearApplyFailure();
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (
      !this.isEnabled &&
      this.connections.connectionCount === 0 &&
      !this.wss &&
      !this.connections.hasInFlightActions
    ) return;
    const wasEnabled = this.isEnabled;
    const wasListening = this.listening;
    const wasAcceptingActions = this.connections.isAcceptingActions;

    this.isEnabled = false;
    this.listening = false;
    const connectionDrain = this.connections.closeConnections();
    const wss = this.wss;
    const releaseResult: Promise<{ error?: Error }> = wss
      ? new Promise<{ error?: Error }>((resolve) => {
        wss.close((error) => resolve(error && !isAlreadyClosedError(error) ? { error } : {}));
      })
      : Promise.resolve({});
    const attempt = (async () => {
      await connectionDrain;
      const release = await releaseResult;
      if (release.error) throw release.error;
    })();
    this.closePromise = attempt;
    try {
      await attempt;
      if (wss && this.wss === wss) this.wss = null;
    } catch (error) {
      // A failed close callback leaves release ambiguous. Retain the server
      // reference and active binding state so a later shutdown can retry.
      this.isEnabled = wasEnabled;
      this.listening = wasListening;
      if (wasAcceptingActions) this.connections.startAccepting();
      throw error;
    } finally {
      this.closePromise = null;
    }
  }

  override describeStatus(): AdapterStatus {
    if (!this.isEnabled) return { name: this.name, kind: 'wsServer', status: 'disabled', detail: '未启用' };
    if (!this.listening) return { name: this.name, kind: 'wsServer', status: 'down', detail: '未监听（端口被占用？）' };
    return {
      name: this.name,
      kind: 'wsServer',
      status: 'ok',
      detail: `${this.connections.connectionCount} 个客户端`,
    };
  }

  protected override bindingSignature(config: WsServerNetwork): string {
    return `${config.host ?? '0.0.0.0'}:${config.port}${normalizePath(config.path)}#${config.role ?? 'auto'}#${config.accessToken ?? ''}`;
  }

  protected override onConfigReplaced(next: WsServerNetwork): void {
    this.connections.updateConfig(next);
  }

  onEvent(_event: JsonObject, payload: DispatchPayload): void {
    if (!this.isEnabled) return;
    this.connections.onEvent(payload);
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      let wss: WebSocketServer;
      try {
        wss = new WebSocketServer({
          host: this.config.host ?? '0.0.0.0',
          port: this.config.port,
          path: normalizePath(this.config.path),
        });
      } catch (error) {
        this.recordTransportFailure(error);
        reject(error);
        return;
      }
      this.wss = wss;
      let opening = true;

      wss.once('listening', () => {
        opening = false;
        if (this.wss !== wss || this.closePromise) {
          wss.close();
          reject(new Error(`WebSocket adapter [${this.name}] was closed while binding`));
          return;
        }
        this.listening = true;
        this.isEnabled = true;
        this.connections.startAccepting();
        this.log.success(
          '[%s] listening %s:%d%s',
          this.name,
          this.config.host ?? '0.0.0.0',
          this.config.port,
          this.config.path ?? '/',
        );
        resolve();
      });

      wss.on('error', (error: Error) => {
        if (this.wss === wss) {
          this.listening = false;
          this.isEnabled = false;
          this.connections.stopAccepting();
          this.recordTransportFailure(error);
          if (opening) this.wss = null;
        }
        this.log.error('[%s] server error: %s', this.name, error instanceof Error ? error.message : String(error));
        if (opening) {
          opening = false;
          reject(error);
        }
      });

      wss.on('connection', (socket, request) => this.connections.accept(socket, request));
    });
  }

  /** Kept as the adapter-level lifecycle test seam. */
  protected get acceptingActions(): boolean {
    return this.connections.isAcceptingActions;
  }

  /** Kept as the adapter-level lifecycle test seam. */
  protected trackInboundAction(start: () => Promise<void>): void {
    this.connections.trackInboundAction(start);
  }
}

function isAlreadyClosedError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING';
}
