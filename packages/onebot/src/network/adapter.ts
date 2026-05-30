import type { ApiHandler } from '../api-handler';
import type { DispatchPayload } from '../event-filter';
import type { JsonObject, NetworkBase } from '../types';

export interface NetworkAdapterContext {
  uin: string;
  api: ApiHandler;
  buildLifecycleEvent(subType: 'connect' | 'enable' | 'disable'): JsonObject;
  buildHeartbeatEvent(): JsonObject;
}

export enum NetworkReloadType {
  Normal = 0,
  Reopened = 1,
  Closed = 2,
  Opened = 3,
}

export type AdapterStatusLevel = 'ok' | 'warn' | 'down' | 'disabled';

/** Live runtime status of a single network adapter, surfaced to the WebUI
 *  dashboard (and the per-node config cards) so the gateway's own
 *  connection health is visible. `detail` is a short human string, e.g.
 *  "3 个客户端" / "重连中" / "上次推送失败 14:53:01". */
export interface AdapterStatus {
  name: string;
  kind: 'httpServer' | 'httpClient' | 'wsServer' | 'wsClient';
  status: AdapterStatusLevel;
  detail: string;
}

export abstract class IOneBotNetworkAdapter<C extends NetworkBase> {
  readonly name: string;
  protected config: C;
  protected readonly ctx: NetworkAdapterContext;
  protected isEnabled = false;

  constructor(name: string, config: C, ctx: NetworkAdapterContext) {
    this.name = name;
    this.config = structuredClone(config);
    this.ctx = ctx;
  }

  get isActive(): boolean { return this.isEnabled; }

  get currentConfig(): Readonly<C> { return this.config; }

  abstract open(): void | Promise<void>;
  abstract close(): void | Promise<void>;
  abstract reload(config: C): NetworkReloadType | Promise<NetworkReloadType>;

  abstract onEvent(event: JsonObject, payload: DispatchPayload): void | Promise<void>;

  /** Report live connection health for the WebUI dashboard. */
  abstract describeStatus(): AdapterStatus;
}
